const { createHandler } = require('@app-core/server');
const parsedInstruction = require('@app/services/payment-processor/parse-instruction');

module.exports = createHandler({
  path: '/payment-instructions',
  method: 'post',
  middlewares: [],

  async handler(requestComponent, helpers) {
    const payload = requestComponent.body;

    const response = await parsedInstruction(payload);

    // Default to success
    let statusCode = helpers.http_statuses.HTTP_200_OK;
    let message = 'Instruction processed successfully';

    if (response && response.status === 'failed') {
      // All validation/parsing failures return 400
      statusCode = helpers.http_statuses.HTTP_400_BAD_REQUEST;

      message = response.status_reason || 'Instruction processing failed';
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
