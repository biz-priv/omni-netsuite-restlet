const nodemailer = require("nodemailer");
const moment = require("moment");
const { parse } = require("json2csv");
const {
  sendDevNotification,
  getConnectionToRds,
} = require("../Helpers/helper");

module.exports.handler = async (event, context, callback) => {
  try {
    connections = await getConnectionToRds(process.env);

    await generateCsvAndMail();
    return "Success";
  } catch (error) {
    console.error("error", error);
    // await sendDevNotification(
    //   "UNPICKED-REPORT",
    //   reportType,
    //   "unpicked_report main fn",
    //   error
    // );
    return "Failed";
  }
};

async function generateCsvAndMail() {
  try {
    const data = await getReportData();
    if (!data || data.length == 0) return;
    /**
     * create csv
     */
    const fields = Object.keys(data[0]);
    const opts = { fields };
    const csv = parse(data, opts);
    /**
     * send mail
     */
    const filename = `Netsuite-Unpicked-Report-${
      process.env.STAGE
    }-report-${moment().format("DD-MM-YYYY")}.csv`;
    await sendMail(filename, csv);
  } catch (error) {
    console.error("error:generateCsvAndMail", error);
    // await sendDevNotification(
    //   "INVOICE-REPOR-" + sourceSystem,
    //   "type value:- " +
    //     type +
    //     " and intercompanyType value:-" +
    //     intercompanyType,
    //   "invoice_report generateCsvAndMail",
    //   {},
    //   error
    // );
  }
}
async function executeQuery(connections, query) {
  try {
    const [rows] = await connections.execute(query);
    return rows;
  } catch (error) {
    throw error;
  }
}

async function getReportData() {
  try {
    const query = "";

    console.info(query);
    const data = await executeQuery(connections, query);
    console.info("data", data.length);
    return data;
  } catch (error) {
    console.error("error:getReportData", error);
    throw error;
  }
}

async function sendMail(filename, content) {
  try {
    const transporter = nodemailer.createTransport({
      host: "",
      port: 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: "",
        pass: "",
      },
    });
    const title = `Netsuite Unpicked Report ${process.env.STAGE.toUpperCase()}`;
    const message = {
      from: `${title} <${process.env.NETSUIT_AR_ERROR_EMAIL_FROM}>`,
      to: "",
      subject: title,
      attachments: [{ filename, content }],
      html: `
          <!DOCTYPE html>
          <html lang="en">
          <head>
              <meta charset="UTF-8">
              <meta http-equiv="X-UA-Compatible" content="IE=edge">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title> ${title} </title>
          </head>
          <body>
            <p> ${title} (${moment().format("DD-MM-YYYY")})</p>
          </body>
          </html>
        `,
    };

    await transporter.sendMail(message);
  } catch (error) {
    console.error("Mail:error", error);
    throw error
  }
}
