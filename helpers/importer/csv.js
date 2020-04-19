'use strict';

const path = require('path');
const neatCsv = require('neat-csv');
const moment = require('moment');
const TransactionLogic = require('../../logic/transaction');

const csv2transactionMap = {
    time: [
        ['Belegdatum', 'DD.MM.YY'],
        ['Buchungstag', 'DD-MM-YY'],
        ['Wertstellung', 'DD-MM-YY'],
        ['Datum', ['DD-MM-YY', 'YYYY-MM-DD']],
        ['Valutadatum', 'DD-MM-YY']
    ],
    pluginsOwnPayeeId: [
        ['Beguenstigter/Zahlungspflichtiger'],
        ['Name'],
        ['Transaktionsbeschreibung'],
        ['Empfänger']
    ],
    memo: [
        ['Verwendungszweck'],
        ['Transaktionsbeschreibung']
    ],
    amount: [
        ['Betrag'],
        ['Buchungsbetrag'],
        ['Betrag (EUR)']
    ]
};


/**
 * CSVImporter
 *
 * @module helpers/importer/csv
 * @class CSVImporter
 */
class CSVImporter {
    static async check (file) {
        return file.mime === 'text/csv' || path.extname(file.name).toLowerCase() === '.csv';
    }

    static async parse (file) {
        const TransactionModel = TransactionLogic.getModel();
        let csv = await neatCsv(file.data, {separator: ';'});
        if(Object.keys(csv[0]).length < 4) {
            csv = await neatCsv(file.data, {separator: ','});
        }


        return csv.map(row => {
            const model = TransactionModel.build();

            Object.entries(csv2transactionMap).forEach(([attr, def]) => {
                def.forEach(([possibleColumn, momentFormat]) => {
                    if (model[attr]) {
                        return;
                    }

                    if (row[possibleColumn] && attr === 'time') {
                        const time = moment(row[possibleColumn], momentFormat);
                        if (time && time.isValid()) {
                            model[attr] = time.toJSON();
                        }
                    }
                    else if (row[possibleColumn] && attr === 'amount') {
                        const amount = parseInt(row[possibleColumn].replace(/,|\./, ''), 10);
                        if (!isNaN(amount) && amount !== 0) {
                            model[attr] = amount;
                        }
                        if (amount === 0) {
                            return;
                        }
                    }
                    else if (typeof row[possibleColumn] === 'string') {
                        model[attr] = row[possibleColumn].trim();
                    }
                });

                if (model[attr] === undefined) {
                    throw new Error(
                        'Unable to import CSV: no value found for `' + attr + '`, parsed this data: ' +
                        JSON.stringify(row, null, '  ')
                    );
                }
            });

            return model;
        });
    }
}


module.exports = CSVImporter;
