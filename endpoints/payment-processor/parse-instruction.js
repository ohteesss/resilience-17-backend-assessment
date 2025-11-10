const { appLogger } = require('@app-core/logger');
const { createHandler } = require('@app-core/server');
const parsedInstruction = require('@app/services/payment-processor/parse-instruction');

module.exports = createHandler({
  path: '/payment-instructions',
  method: 'post',
  middlewares: [],
  async onResponseEnd(rc, rs) {
    appLogger.info({ requestContext: rc, response: rs }, 'login-request-completed');
  },
  async handler(rc, helpers) {
    const payload = rc.body;

    const response = await parsedInstruction(payload);

    // Default to success
    let statusCode = helpers.http_statuses.HTTP_200_OK;
    let message = 'Instruction processed successfully';

    if (response && response.status === 'failed') {
      // All validation/parsing failures return 400
      statusCode = helpers.http_statuses.HTTP_400_BAD_REQUEST;

      // Provide a clear human-readable message. Enhance insufficient funds message with account details when available.
      if (response.status_code === 'AC01') {
        // Try to find debit account details from response.accounts
        const debitId =
          response.debit_account ||
          (response.accounts && response.accounts[0] && response.accounts[0].id);
        const acct = (response.accounts || []).find((a) => a.id === debitId) || null;
        if (acct) {
          message = `${response.status_reason} in account ${acct.id}: has ${acct.balance} ${acct.currency}, needs ${response.amount} ${response.currency}`;
        } else {
          message = response.status_reason || 'Insufficient funds';
        }
      } else {
        message = response.status_reason || 'Instruction validation failed';
      }
    } else if (response && response.status === 'pending') {
      statusCode = helpers.http_statuses.HTTP_200_OK;
      message = response.status_reason || 'Instruction scheduled for execution';
    } else if (response && response.status === 'successful') {
      statusCode = helpers.http_statuses.HTTP_200_OK;
      message = response.status_reason || 'Instruction executed successfully';
    }

    return {
      status: statusCode,
      message,
      data: response,
    };
  },
});
