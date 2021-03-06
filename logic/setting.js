'use strict';

const BaseLogic = require('./_');
const LogHelper = require('../helpers/log');
const DatabaseHelper = require('../helpers/database');
const ErrorResponse = require('../helpers/errorResponse');
const log = new LogHelper('SettingLogic');

class SettingLogic extends BaseLogic {
    static getModelName() {
        return 'setting';
    }

    static getPluralModelName() {
        return 'settings';
    }

    static format(setting) {
        let value = null;

        if (setting.value !== undefined && setting.value !== null) {
            try {
                value = JSON.parse(setting.value);
            }
            catch (err) {
                log.warn(new Error('Unable to parse setting value `' + setting.value + '`:'));
            }
        }

        return {
            id: setting.id,
            documentId: setting.documentId,
            key: setting.key,
            value: value
        };
    }

    static async create(attributes, options) {
        const model = this.getModel().build();

        model.key = attributes.key;
        if (!model.key) {
            throw new ErrorResponse(400, 'Setting requires attribute `key`…', {
                attributes: {
                    key: 'Is required!'
                }
            });
        }

        model.value = JSON.stringify(attributes.value);

        model.documentId = attributes.documentId;
        if (!model.documentId) {
            throw new ErrorResponse(400, 'Setting requires attribute `documentId`…', {
                attributes: {
                    documentId: 'Is required!'
                }
            });
        }

        const document = await DatabaseHelper.get('document').findOne({
            attributes: ['id'],
            where: {
                id: model.documentId
            },
            include: DatabaseHelper.includeUserIfNotAdmin(options.session, {through: true})
        });
        if (!document) {
            throw new ErrorResponse(400, 'Document given in `documentId` not found…', {
                attributes: {
                    documentId: 'Document not found'
                }
            });
        }

        model.documentId = document.id;

        try {
            await model.save();
        }
        catch(err) {
            if (err.toString().indexOf('SequelizeUniqueConstraintError') > -1) {
                throw new ErrorResponse(400, 'Setting with this key already exists in document…', {
                    attributes: {
                        key: 'Already exists'
                    }
                });
            }

            throw err;
        }

        return {model};
    }

    static async get(id, options) {
        return this.getModel().findOne({
            where: {id},
            include: [{
                model: DatabaseHelper.get('document'),
                attributes: [],
                include: DatabaseHelper.includeUserIfNotAdmin(options.session)
            }]
        });
    }

    static async list(params, options) {
        return this.getModel().findAll({
            include: [{
                model: DatabaseHelper.get('document'),
                required: true,
                include: DatabaseHelper.includeUserIfNotAdmin(options.session)
            }]
        });
    }

    static async update(model, body) {
        if (body.key !== undefined && body.key !== model.key) {
            throw new ErrorResponse(400, 'It\'s not allowed to change the Setting key…', {
                attributes: {
                    key: 'Changes not allowed'
                }
            });
        }
        if (body.documentId !== undefined && body.documentId !== model.documentId) {
            throw new ErrorResponse(400, 'It\'s not allowed to change the Setting document id…', {
                attributes: {
                    key: 'Changes not allowed'
                }
            });
        }

        model.value = JSON.stringify(body.value);
        await model.save();

        return {model};
    }
}

module.exports = SettingLogic;