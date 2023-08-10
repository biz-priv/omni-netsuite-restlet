const log4js = require("log4js");
const moment = require("moment-timezone");
moment.tz.setDefault("America/Chicago");

log4js.configure({
  appenders: {
    out: { type: "stdout", layout: { type: "messagePassThrough" } },
  },
  categories: { default: { appenders: ["out"], level: "info" } },
});
const logger = log4js.getLogger("out");

async function log(correlationId, message, status = null, type = "info") {
  let logMsg = {
    "@timestamp": moment().format(),
    correlationId,
    message,
    "service-name": process.env.SERVICE_NAME,
    application: process.env.APPLICATION,
    functionName: process.env.FUNCTION_NAME,
  };
  if (status)
    logMsg.status = typeof status === "string" ? status : String(status);
  if (type === "info") logger.info(JSON.stringify(logMsg));
  else logger.error(JSON.stringify(logMsg));
}

async function logUtilization(customerNumber) {
  logger.info(
    JSON.stringify({
      "@timestamp": moment().format(),
      "service-name": process.env.SERVICE_NAME,
      application: process.env.APPLICATION,
      functionName: process.env.FUNCTION_NAME,
      additionalFields: {
        customerNumber,
      },
    })
  );
}

module.exports = { log, logUtilization };
