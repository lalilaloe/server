'use strict';

const BaseLogic = require('./_');
const ErrorResponse = require('../helpers/errorResponse');

class SummaryLogic extends BaseLogic {
    static getModelName () {
        return 'summary';
    }

    static getPluralModelName () {
        return 'summaries';
    }

    static format (summary) {
        const moment = require('moment');

        return {
            id: summary.id,
            month: moment(summary.month).format('YYYY-MM'),
            available: summary.available,
            availableLastMonth: summary.availableLastMonth,
            income: summary.income,
            budgeted: summary.budgeted,
            outflow: summary.outflow,
            balance: summary.balance,
            documentId: summary.documentId
        };
    }

    static async get (id, options) {
        const DatabaseHelper = require('../helpers/database');
        return this.getModel().findOne({
            where: {
                id: id
            },
            include: [{
                model: DatabaseHelper.get('document'),
                attributes: [],
                required: true,
                include: options.session.user.isAdmin ? [] : [{
                    model: DatabaseHelper.get('user'),
                    attributes: [],
                    where: {
                        id: options.session.userId
                    }
                }]
            }]
        });
    }

    static async list (params, options) {
        const moment = require('moment');
        const DatabaseHelper = require('../helpers/database');

        if (!params.document) {
            throw new ErrorResponse(400, 'Can not list portions without document…', {
                attributes: {
                    document: 'Is required!'
                }
            });
        }

        const monthMoment = moment(params.month, 'YYYY-MM');
        const month = monthMoment.format('YYYY-MM');
        if (!monthMoment.isValid()) {
            throw new ErrorResponse(400, 'Can not list portions without month…', {
                attributes: {
                    month: 'Is required!'
                }
            });
        }

        /*
         *   1. Fetch Summary
         */
        let summary = await SummaryLogic.getModel().findOne({
            where: {
                month
            },
            include: [{
                model: DatabaseHelper.get('document'),
                attributes: ['id'],
                where: {
                    id: params.document
                },

                include: options.session.user.isAdmin ? [] : [{
                    model: DatabaseHelper.get('user'),
                    attributes: ['id'],
                    where: {
                        id: options.session.userId
                    }
                }]
            }]
        });
        if (summary) {
            return [summary];
        }

        /*
         *   2. Create Summary if it's not already there
         */
        const document = await DatabaseHelper.get('document').findOne({
            where: {
                id: params.document
            },
            include: DatabaseHelper.includeUserIfNotAdmin(options.session)
        });
        if (!document) {
            throw new ErrorResponse(400, 'Not able to get summary: linked document not found.');
        }

        summary = await SummaryLogic.getModel().build({
            month,
            documentId: document.id
        });

        await SummaryLogic.recalculateSummary(summary);
        return [summary];
    }

    static async recalculateSummariesFrom (documentId, month) {
        const moment = require('moment');
        const DatabaseHelper = require('../helpers/database');
        const monthMoment = moment(month);
        if (!monthMoment.isValid()) {
            throw new Error('Invalid Month: ' + month);
        }

        const query = {
            where: {
                documentId,
                month: {
                    [DatabaseHelper.op('gte')]: moment(monthMoment).format('YYYY-MM')
                }
            }
        };

        const summaries = await SummaryLogic.getModel().findAll(query);
        await Promise.all(summaries.map(SummaryLogic.recalculateSummary));
    }

    static async recalculateSummary (summary) {
        const moment = require('moment');
        const DatabaseHelper = require('../helpers/database');
        const monthMoment = moment(summary.month);

        const calculated = await Promise.all([
            /*
             *   0: incomeTillLastMonth
             */
            DatabaseHelper.get('unit').findOne({
                attributes: [
                    [DatabaseHelper.sum('unit.amount'), 'incomeTillLastMonth']
                ],
                where: {
                    [DatabaseHelper.op('or')]: [
                        {
                            type: 'INCOME',
                            '$transaction.time$': {
                                [DatabaseHelper.op('lte')]: moment(monthMoment).subtract(1, 'month').endOf('month').toJSON()
                            }
                        },
                        {
                            type: 'INCOME_NEXT',
                            '$transaction.time$': {
                                [DatabaseHelper.op('lte')]: moment(monthMoment).subtract(2, 'month').endOf('month').toJSON()
                            }
                        }
                    ]
                },
                include: [{
                    model: DatabaseHelper.get('transaction'),
                    attributes: [],
                    required: true,
                    include: [{
                        model: DatabaseHelper.get('account'),
                        attributes: [],
                        where: {
                            documentId: summary.documentId
                        }
                    }]
                }],
                raw: true
            }),

            /*
             *   1: budgetedTillLastMonth
             */
            DatabaseHelper.get('portion').findOne({
                attributes: [
                    [DatabaseHelper.sum('budgeted'), 'budgetedTillLastMonth']
                ],
                where: {
                    month: {
                        [DatabaseHelper.op('lte')]: moment(monthMoment).subtract(1, 'month').format('YYYY-MM')
                    }
                },
                include: [{
                    model: DatabaseHelper.get('budget'),
                    attributes: [],
                    required: true,
                    include: [{
                        model: DatabaseHelper.get('category'),
                        attributes: [],
                        where: {
                            documentId: summary.documentId
                        }
                    }]
                }],
                raw: true
            }),

            /*
             *   2: unbudgetedUnitsTillLastMonth
             */
            DatabaseHelper.get('unit').findOne({
                attributes: [
                    [DatabaseHelper.sum('unit.amount'), 'unbudgetedUnitsTillLastMonth']
                ],
                where: {
                    type: null
                },
                include: [{
                    model: DatabaseHelper.get('transaction'),
                    attributes: [],
                    where: {
                        time: {
                            [DatabaseHelper.op('lte')]: moment(monthMoment).subtract(1, 'month').endOf('month').toJSON()
                        }
                    },
                    include: [{
                        model: DatabaseHelper.get('account'),
                        attributes: [],
                        where: {
                            documentId: summary.documentId
                        }
                    }]
                }],
                raw: true
            }),

            /*
             *   3: unbudgetedTransactionsTillLastMonth
             */
            DatabaseHelper.query(
                'SELECT SUM(`amount`) AS `unbudgetedTransactionsTillLastMonth` ' +
                'FROM `transactions` AS `transaction` ' +
                'WHERE ' +
                '  `transaction`.`time` <= "' + moment(monthMoment).subtract(1, 'month').endOf('month').toJSON() + '" AND ' +
                '  (SELECT COUNT(*) FROM `units` WHERE `units`.`transactionId` = `transaction`.`id`) = 0 AND ' +
                '  `accountId` IN (SELECT `id` FROM `accounts` WHERE `documentId` = "' + summary.documentId + '");'
            ),

            /*
             *   4: incomeThisMonth
             */
            DatabaseHelper.get('unit').findOne({
                attributes: [
                    [DatabaseHelper.sum('unit.amount'), 'incomeThisMonth']
                ],
                where: {
                    [DatabaseHelper.op('or')]: [
                        {
                            type: 'INCOME',
                            '$transaction.time$': {
                                [DatabaseHelper.op('lte')]: moment(monthMoment).endOf('month').toJSON(),
                                [DatabaseHelper.op('gte')]: moment(monthMoment).startOf('month').toJSON()
                            }
                        },
                        {
                            type: 'INCOME_NEXT',
                            '$transaction.time$': {
                                [DatabaseHelper.op('lte')]: moment(monthMoment).subtract(1, 'month').endOf('month').toJSON(),
                                [DatabaseHelper.op('gte')]: moment(monthMoment).subtract(1, 'month').startOf('month').toJSON()
                            }
                        }
                    ]
                },
                include: [{
                    model: DatabaseHelper.get('transaction'),
                    attributes: [],
                    required: true,
                    include: [{
                        model: DatabaseHelper.get('account'),
                        attributes: [],
                        where: {
                            documentId: summary.documentId
                        }
                    }]
                }],
                raw: true
            }),

            /*
             *   5: all portion's budgeted this month
             */
            DatabaseHelper.get('portion').findOne({
                attributes: [
                    [DatabaseHelper.sum('budgeted'), 'budgetedThisMonth']
                ],
                where: {
                    month: {
                        [DatabaseHelper.op('lte')]: moment(monthMoment).format('YYYY-MM'),
                        [DatabaseHelper.op('gte')]: moment(monthMoment).format('YYYY-MM')
                    }
                },
                include: [{
                    model: DatabaseHelper.get('budget'),
                    attributes: [],
                    required: true,
                    include: [{
                        model: DatabaseHelper.get('category'),
                        attributes: [],
                        where: {
                            documentId: summary.documentId
                        }
                    }]
                }],
                raw: true
            }),

            /*
             *   6: all unbudgeted units this month
             */
            DatabaseHelper.get('unit').findOne({
                attributes: [
                    [DatabaseHelper.sum('unit.amount'), 'unbudgetedUnitsThisMonth']
                ],
                where: {
                    type: null
                },
                include: [{
                    model: DatabaseHelper.get('transaction'),
                    attributes: [],
                    where: {
                        time: {
                            [DatabaseHelper.op('lte')]: moment(monthMoment).endOf('month').toJSON(),
                            [DatabaseHelper.op('gte')]: moment(monthMoment).startOf('month').toJSON()
                        }
                    },
                    include: [{
                        model: DatabaseHelper.get('account'),
                        attributes: [],
                        where: {
                            documentId: summary.documentId
                        }
                    }]
                }],
                raw: true
            }),

            /*
             *   7: unbudgetedTransactionsThisMonth
             */
            DatabaseHelper.query(
                'SELECT SUM(`amount`) AS `unbudgetedTransactionsThisMonth` ' +
                'FROM `transactions` AS `transaction` ' +
                'WHERE ' +
                '  `transaction`.`time` <= "' + moment(monthMoment).endOf('month').toJSON() + '" AND ' +
                '  `transaction`.`time` >= "' + moment(monthMoment).startOf('month').toJSON() + '" AND ' +
                '  (SELECT COUNT(*) FROM `units` WHERE `units`.`transactionId` = `transaction`.`id`) = 0 AND ' +
                '  `accountId` IN (SELECT `id` FROM `accounts` WHERE `documentId` = "' + summary.documentId + '");'
            ),

            /*
             *   8: outflowUnitsThisMonth
             */
            DatabaseHelper.get('unit').findOne({
                attributes: [
                    [DatabaseHelper.sum('unit.amount'), 'outflowUnitsThisMonth']
                ],
                where: {
                    '$transaction.time$': {
                        [DatabaseHelper.op('lte')]: moment(monthMoment).endOf('month').toJSON(),
                        [DatabaseHelper.op('gte')]: moment(monthMoment).startOf('month').toJSON()
                    },
                    [DatabaseHelper.op('or')]: [
                        {
                            type: null
                        },
                        {
                            type: 'BUDGET'
                        }
                    ]
                },
                include: [{
                    model: DatabaseHelper.get('transaction'),
                    attributes: [],
                    required: true,
                    include: [{
                        model: DatabaseHelper.get('account'),
                        attributes: [],
                        where: {
                            documentId: summary.documentId
                        }
                    }]
                }],
                raw: true
            }),

            /*
             *   9: balance
             */
            DatabaseHelper.query(
                'SELECT SUM(' +
                '   (' + // Transactions without any units
                '   SELECT IFNULL(SUM(amount), 0)' +
                '    FROM transactions as t ' +
                '    WHERE t.accountId = account.id ' +
                '     AND t.time < "' + moment(monthMoment).endOf('month').toJSON() + '"' +
                '     AND (' +
                '      SELECT COUNT(*) ' +
                '       FROM units ' +
                '       WHERE units.transactionId = t.id' +
                '     ) = 0' +
                ' ) + ' +
                ' (' + // Not a transfer (budgeted or income)
                '   SELECT IFNULL(SUM(amount), 0)' +
                '    FROM units as u' +
                '    WHERE u.type != "TRANSFER" ' +
                '     AND u.transactionId IN (' +
                '       SELECT id FROM transactions AS t WHERE t.accountId = account.id ' +
                '        AND t.time < "' + moment(monthMoment).endOf('month').toJSON() + '"' +
                '     )' +
                ' ) +' +
                ' (' + // Transfer from account
                '   SELECT IFNULL(SUM(amount), 0)' +
                '    FROM units AS u' +
                '    WHERE u.type = "TRANSFER"' +
                '     AND u.transactionId IN (' +
                '       SELECT id FROM transactions AS t WHERE t.accountId = account.id ' +
                '         AND t.time < "' + moment(monthMoment).endOf('month').toJSON() + '"' +
                '       )' +
                ' ) -' +
                ' (' + // Transfer to account
                '   SELECT IFNULL(SUM(amount), 0)' +
                '    FROM units AS u' +
                '    WHERE u.type = "TRANSFER"' +
                '     AND u.transferAccountId = account.id' +
                '     AND u.transactionId IN (' +
                '       SELECT id FROM transactions AS t ' +
                '        WHERE t.time < "' + moment(monthMoment).endOf('month').toJSON() + '"' +
                '     )' +
                ' )' +
                ') as balance FROM accounts AS account WHERE account.documentId = "' + summary.documentId + '";'
            )
        ]);

        // till last month
        const incomeTillLastMonth = parseInt(calculated[0].incomeTillLastMonth) || 0;
        const budgetedTillLastMonth = parseInt(calculated[1].budgetedTillLastMonth) || 0;
        const unbudgetedUnitsTillLastMonth = parseInt(calculated[2].unbudgetedUnitsTillLastMonth) || 0;
        const unbudgetedTransactionsTillLastMonth = parseInt(calculated[3][0].unbudgetedTransactionsTillLastMonth) || 0;

        // this month
        const incomeThisMonth = parseInt(calculated[4].incomeThisMonth) || 0;
        const budgetedThisMonth = parseInt(calculated[5].budgetedThisMonth) || 0;
        const unbudgetedUnitsThisMonth = parseInt(calculated[6].unbudgetedUnitsThisMonth) || 0;
        const unbudgetedTransactionsThisMonth = parseInt(calculated[7][0].unbudgetedTransactionsThisMonth) || 0;
        const outflowUnitsThisMonth = parseInt(calculated[8].outflowUnitsThisMonth) || 0;

        // till this month
        const incomeTillThisMonth = incomeTillLastMonth + incomeThisMonth;
        const budgetedTillThisMonth = budgetedTillLastMonth + budgetedThisMonth;
        const unbudgetedUnitsTillThisMonth = unbudgetedUnitsTillLastMonth + unbudgetedUnitsThisMonth;
        const unbudgetedTransactionsTillThisMonth = unbudgetedTransactionsTillLastMonth + unbudgetedTransactionsThisMonth;
        const balance = parseInt(calculated[9][0].balance) || 0;

        summary.available = incomeTillThisMonth - budgetedTillThisMonth +
            unbudgetedUnitsTillThisMonth + unbudgetedTransactionsTillThisMonth;

        summary.availableLastMonth = incomeTillLastMonth - budgetedTillLastMonth +
            unbudgetedUnitsTillLastMonth + unbudgetedTransactionsTillLastMonth;

        summary.income = incomeThisMonth;
        summary.budgeted = budgetedThisMonth;
        summary.unbudgeted = unbudgetedUnitsThisMonth + unbudgetedTransactionsThisMonth;
        summary.outflow = outflowUnitsThisMonth + unbudgetedTransactionsThisMonth;
        summary.balance = balance;

        await summary.save();
    }
}

module.exports = SummaryLogic;
