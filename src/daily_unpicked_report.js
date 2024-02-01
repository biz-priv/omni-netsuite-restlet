const nodemailer = require("nodemailer");
const moment = require("moment");
const { parse } = require("json2csv");
const pgp = require("pg-promise");
const dbc = pgp({ capSQL: true });
const {
  sendDevNotification,
  getConnectionToRds,
} = require("../Helpers/helper");
const dbname = process.env.DATABASE_NAME;

module.exports.handler = async (event, context, callback) => {
  try {
    let connections = await getConnectionToRds(process.env);

    let redshiftConnections = dbc(getRedshiftConnection(process.env));

    await generateCsvAndMail([connections, redshiftConnections], [dbname, ""]);
    return "Success";
  } catch (error) {
    console.error("error", error);
    await sendDevNotification(
      "ALL SOURCE SYSTEM UNPICKED DATA",
      "REPORT",
      "Unpicked_report main fn",
      {},
      error
    );
    return "Failed";
  }
};

async function generateCsvAndMail(conArray, dbArray) {
  try {
    let emailData = [];
    for (let source_system of ["ar", "ap"]) {
      let data = [];
      for (let i = 0; i < 2; i++) {
        const rows = await getReportData(
          conArray[i],
          dbArray[i],
          source_system
        );
        console.log("dbname: ", dbArray[i], "length: ", rows.length);
        data = [...data, ...rows];
      }
      console.log("total length: ", data.length);
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
      const filename = `Netsuite-${source_system.toUpperCase()}-Unpicked-Report-${
        process.env.STAGE
      }-report-${moment().format("DD-MM-YYYY")}.csv`;
      emailData.push({ filename: filename, content: csv });
    }
    await sendMail(emailData);
  } catch (error) {
    console.error("error:generateCsvAndMail", error);
    await sendDevNotification(
      "ALL SOURCE SYSTEM UNPICKED DATA",
      "REPORT",
      "Unpicked_report generateCsvAndMail",
      {},
      error
    );
  }
}
async function executeQuery(connections, query, db) {
  try {
    if (db == "") {
      const rows = await connections.query(query);
      return rows;
    }
    const [rows] = await connections.execute(query);
    return rows;
  } catch (error) {
    throw error;
  }
}

async function getReportData(connections, db, source_system) {
  try {
    let query = "";
    if (source_system == "ap") {
      query = `select source_system ,file_nbr ,vendor_id ,subsidiary ,invoice_nbr , housebill_nbr ,
    business_segment ,invoice_type,handling_stn ,currency ,rate,gc_code , unique_ref_nbr,mode_name ,service_level  
    from ${db}interface_ap where intercompany ='Y' and pairing_available_flag is null`;
    }else{
      query = `select source_system ,file_nbr ,customer_id ,subsidiary ,invoice_nbr , housebill_nbr ,
    business_segment ,invoice_type,handling_stn ,rate,gc_code , unique_ref_nbr,mode_name ,service_level  
    from ${db}interface_ar where intercompany ='Y' and pairing_available_flag is null`;
    }

    console.info(query);
    const data = await executeQuery(connections, query, db);
    console.info("data", data.length);
    return data;
  } catch (error) {
    console.error("error:getReportData", error);
    throw error;
  }
}

async function sendMail(emailData) {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.NETSUIT_AR_ERROR_EMAIL_HOST,
      port: 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: process.env.NETSUIT_AR_ERROR_EMAIL_USER,
        pass: process.env.NETSUIT_AR_ERROR_EMAIL_PASS,
      },
    });
    const title = `Netsuite Unpicked Report ${process.env.STAGE.toUpperCase()}`;
    const message = {
      from: `${title} <${process.env.NETSUIT_AR_ERROR_EMAIL_FROM}>`,
      to: "omnidev@bizcloudexperts.com",
      subject: title,
      attachments: emailData,
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
    throw error;
  }
}

function getRedshiftConnection(env) {
  try {
    const dbUser = env.USER;
    const dbPassword = env.PASS;
    const dbHost = "omni-dw-prod.cnimhrgrtodg.us-east-1.redshift.amazonaws.com";
    const dbPort = env.PORT;
    const dbName = env.DBNAME;

    const connectionString = `postgres://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;
    return connectionString;
  } catch (error) {
    console.info("connection error:-  ", error);
    throw "DB Connection Error";
  }
}
