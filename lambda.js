"use strict";

/* Entrada Lambda (Function URL, payload v2). Storage S3 via LOUSA_BUCKET. */

const { handleRequest } = require("./core");

exports.handler = async event => {
  const http = event.requestContext?.http || {};
  const headers = {};
  for (const [name, value] of Object.entries(event.headers || {})) headers[name.toLowerCase()] = value;

  const body = event.body
    ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8")
    : Buffer.alloc(0);

  try {
    const result = await handleRequest({
      method: http.method || "GET",
      path: event.rawPath || "/",
      query: new URLSearchParams(event.rawQueryString || ""),
      headers,
      body,
    });
    const isBuffer = Buffer.isBuffer(result.body);
    return {
      statusCode: result.status,
      headers: result.headers,
      body: isBuffer ? result.body.toString("base64") : result.body,
      isBase64Encoded: isBuffer,
    };
  } catch (error) {
    console.error(`[error] ${error.stack || error.message}`);
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Internal error." }) };
  }
};
