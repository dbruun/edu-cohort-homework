const { readPolicy, writePolicy } = require('./policy');

module.exports = async function (context, req) {
  const route = req?.url || '/';
  const method = req?.method || 'GET';

  if (route === '/api/policy' && method === 'GET') {
    context.res = {
      status: 200,
      body: readPolicy()
    };
    return;
  }

  if (route === '/api/policy' && method === 'POST') {
    const body = req?.body || {};
    const updatedPolicy = writePolicy(body);
    context.res = {
      status: 200,
      body: updatedPolicy
    };
    return;
  }

  context.res = {
    status: 200,
    body: {
      message: 'Professor API ready',
      method,
      route
    }
  };
};
