'use strict';

const EventEmitter = require('events');
const LogHelper = require('../log');
const DatabaseHelper = require('../database');
const PluginInstance = require('./instance');
const log = new LogHelper('PluginHelper');


const pluginEvents = new EventEmitter();
let initialized = false;
let plugins = [];


/**
 * PluginHelper
 *
 * @module helpers/plugin
 * @class PluginHelper
 */
class PluginHelper {
    static async initialize () {
        if (initialized) {
            return;
        }

        let models;
        initialized = true;

        try {
            models = await DatabaseHelper.get('plugin-instance').findAll();
        }
        catch (err) {
            log.fatal('Unable to fetch used plugins: %s', err);
            throw err;
        }

        plugins = models.map(plugin => new PluginInstance(plugin, pluginEvents));
    }

    static async listPlugins () {
        return plugins;
    }

    /**
     * installPlugin()
     *
     * Installs the given plugin for the selected document. For type, all parameters
     * specified for `npm install` are valid (see https://docs.npmjs.com/cli/install).
     *
     *
     * ### Sequence
     *
     * - run npm install
     *    - Fails: error
     *
     * - check plugin basics
     *    - Fails: uninstall plugin + error
     *
     * - add plugin to database
     *    - Fails: error
     *
     * - add plugin to ram db
     *
     * - check plugin configuration
     *    - Fails: uninstall plugin + error
     *    - Valid: go to ready state
     *    - Invalid: go to waiting for configuration state
     *
     * @param {string} type Plugin type, for example "@ubud-app/plugin-n26" or "~/my-plugin"
     * @param {Sequelize.Model} document
     * @param {object} [options]
     * @param {boolean} [options.dontLoad] Don't load plugin instance. Method will return null then.
     * @returns {Promise.<PluginInstance>}
     */
    static async installPlugin (type, document, options) {
        options = options || {};

        /*
         *  npm install
         */
        type = await this._runPackageInstall(type);
        log.debug('%s: installed successfully', type);


        /*
         *  run plugin checks
         */
        try {
            await PluginInstance.check(type);
            log.debug('%s: checks passed', type);
        }
        catch (err) {

            // remove plugin again
            // @todo only if not used otherwise
            try {
                await this._runPackageRemove(type);
                log.debug('%s: removed successfully', type);
            }
            catch (err) {
                log.warn('%s: unable to remove plugin: %s', type, err);
            }

            throw err;
        }


        /*
         *  add instance to database
         */
        const model = await DatabaseHelper.get('plugin-instance').create({type, documentId: document.id});
        if (options.dontLoad) {
            return null;
        }

        const instance = new PluginInstance(model, pluginEvents);
        plugins.push(instance);

        return instance;
    }


    /**
     * removePlugin()
     *
     * @param {PluginInstance} instance
     * @returns {Promise.<void>}
     */
    static async removePlugin (instance) {
        // stop plugin
        await instance.destroy();

        // destroy database model
        await instance.model().destroy();

        // remove plugin from index
        const i = plugins.indexOf(instance);
        if (i !== -1) {
            plugins.splice(i, 1);
        }

        // get package usages by other plugin instances
        const usages = await DatabaseHelper.get('plugin-instance').count({
            where: {
                type: instance.type()
            }
        });

        // remove package if not used anymore
        if (!usages) {
            await this._runPackageRemove(instance.type());
        }
    }


    /**
     * Returns the event object used to transmit all
     * plugin events to our sockets…
     *
     * @returns {EventEmitter}
     */
    static events () {
        return pluginEvents;
    }


    static async _runPackageInstall (type) {
        let res;

        try {
            res = await this._runPackageRunQueue(['npm', 'install', '--ignore-scripts', '--production', type]);
        }
        catch (err) {
            log.error(err);
            throw new Error('Unable to install required package via npm`: ' + err.string);
        }

        const id = res.split('\n').find(l => l.trim().substr(0, 1) === '+');
        if (!id) {
            throw new Error(`Plugin installed, but unable to get plugin name. Output was \`${res}\``);
        }

        const path = require.resolve(type + '/');
        log.debug('Plugin installation done, path is ' + path);

        Object.keys(require.cache)
            .filter(key => key.substr(0, path.length) === path)
            .forEach(key => {
                log.debug('Invalidated cached module: ' + key);
                delete require.cache[key];
            });

        return id.substr(2, id.lastIndexOf('@') - 2).trim();
    }

    static async _runPackageRemove (type) {
        await this._runPackageRunQueue(['npm', 'remove', type]);
    }

    static async _runPackageRunQueue (command) {
        const id = command.join(' ');
        log.debug('_runPackageRunQueue: %s: add', id);

        this._runPackageRunQueue.q = this._runPackageRunQueue.q || [];
        this._runPackageRunQueue.e = this._runPackageRunQueue.e || new EventEmitter();

        // already in queue?
        const i = this._runPackageRunQueue.q.find(i => i[0] === id);
        if (i) {
            log.debug('_runPackageRunQueue: %s: already in queue', id);
            return i[2];
        }

        // add to queue
        const item = [
            id,
            command,
            new Promise(resolve => {
                const l = _id => {
                    if (_id === id) {
                        this._runPackageRunQueue.e.off('start', l);
                        resolve();
                    }
                };
                this._runPackageRunQueue.e.on('start', l);
            }).then(() => {
                log.debug('_runPackageRunQueue: %s: running', id);

                const exec = require('promised-exec');
                const escape = require('shell-escape');

                return exec(escape(command));
            }).finally(() => {
                log.debug('_runPackageRunQueue: %s: done', id);
                const i = this._runPackageRunQueue.q.indexOf(item);
                if(i >= 0) {
                    log.debug('_runPackageRunQueue: %s: remove queue item', id);
                    this._runPackageRunQueue.q.splice(i, 1);
                }
                if(this._runPackageRunQueue.q.length > 0) {
                    setTimeout(() => {
                        log.debug('_runPackageRunQueue: %s: start next item: %s', id, this._runPackageRunQueue.q[0][0]);
                        this._runPackageRunQueue.e.emit('start', this._runPackageRunQueue.q[0][0]);
                    }, 5000);
                }
            })
        ];
        this._runPackageRunQueue.q.push(item);
        log.debug('_runPackageRunQueue: %s: added, now %i items in queue', id, this._runPackageRunQueue.q.length);

        if (this._runPackageRunQueue.q.length === 1) {
            log.debug('_runPackageRunQueue: %s: kickstart queue', id);
            this._runPackageRunQueue.e.emit('start', this._runPackageRunQueue.q[0][0]);
        }

        return item[2];
    }
}


module.exports = PluginHelper;