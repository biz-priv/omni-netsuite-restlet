const AWS = require("aws-sdk");
const moment = require("moment");
const mysql = require("mysql2/promise");
const nodemailer = require("nodemailer");
const lambda = new AWS.Lambda();
const dbname = process.env.DATABASE_NAME;

/**
 * Config for Netsuite
 * @param {*} source_system
 * @param {*} env
 * @returns
 */
function getConfig(source_system, env) {
  const data = {
    WT: {
      account: env.NETSUIT_AR_ACCOUNT,
      apiVersion: "2021_2",
      accountSpecificUrl: true,
      token: {
        consumer_key: env.NETSUIT_AR_CONSUMER_KEY,
        consumer_secret: env.NETSUIT_AR_CONSUMER_SECRET,
        token_key: env.NETSUIT_AR_TOKEN_KEY,
        token_secret: env.NETSUIT_AR_TOKEN_SECRET,
      },
      wsdlPath: env.NETSUIT_AR_WDSLPATH,
    },
    CW: {
      account: env.NETSUIT_AR_ACCOUNT,
      apiVersion: "2021_2",
      accountSpecificUrl: true,
      token: {
        consumer_key: env.NETSUIT_AR_CONSUMER_KEY,
        consumer_secret: env.NETSUIT_AR_CONSUMER_SECRET,
        token_key: env.NETSUIT_AR_TOKEN_KEY,
        token_secret: env.NETSUIT_AR_TOKEN_SECRET,
      },
      wsdlPath: env.NETSUIT_AR_WDSLPATH,
    },
    M1: {
      account: env.NETSUIT_AR_ACCOUNT,
      apiVersion: "2021_2",
      accountSpecificUrl: true,
      token: {
        consumer_key: env.NETSUIT_AR_CONSUMER_KEY,
        consumer_secret: env.NETSUIT_AR_CONSUMER_SECRET,
        token_key: env.NETSUIT_AR_TOKEN_KEY,
        token_secret: env.NETSUIT_AR_TOKEN_SECRET,
      },
      wsdlPath: env.NETSUIT_AR_WDSLPATH,
    },
    TR: {
      account: env.NETSUIT_AR_ACCOUNT,
      apiVersion: "2021_2",
      accountSpecificUrl: true,
      token: {
        consumer_key: env.NETSUIT_AR_CONSUMER_KEY,
        consumer_secret: env.NETSUIT_AR_CONSUMER_SECRET,
        token_key: env.NETSUIT_AR_TOKEN_KEY,
        token_secret: env.NETSUIT_AR_TOKEN_SECRET,
      },
      wsdlPath: env.NETSUIT_AR_WDSLPATH,
    },
    OL: {
      account: env.NETSUIT_AR_ACCOUNT,
      apiVersion: "2021_2",
      accountSpecificUrl: true,
      token: {
        consumer_key: env.NETSUIT_AR_CONSUMER_KEY,
        consumer_secret: env.NETSUIT_AR_CONSUMER_SECRET,
        token_key: env.NETSUIT_AR_TOKEN_KEY,
        token_secret: env.NETSUIT_AR_TOKEN_SECRET,
      },
      wsdlPath: env.NETSUIT_AR_WDSLPATH,
    },
    LL: {
      account: env.NETSUIT_AR_ACCOUNT,
      apiVersion: "2021_2",
      accountSpecificUrl: true,
      token: {
        consumer_key: env.NETSUIT_AR_CONSUMER_KEY,
        consumer_secret: env.NETSUIT_AR_CONSUMER_SECRET,
        token_key: env.NETSUIT_AR_TOKEN_KEY,
        token_secret: env.NETSUIT_AR_TOKEN_SECRET,
      },
      wsdlPath: env.NETSUIT_AR_WDSLPATH,
    }
  };
  return data[source_system];
}

/**
 * Config for connections
 * @param {*} env
 * @returns
 */

async function getConnectionToRds(env) {
  try {
    const dbUser = env.db_username;
    const dbPassword = env.db_password;
    const dbHost = env.db_host
    const dbPort = env.db_port;
    const dbName = env.db_name;
    const connection = await mysql.createConnection({
      host: dbHost,
      user: dbUser,
      password: dbPassword,
      database: dbName,
      port: dbPort,
    });
    return connection;
  } catch (error) {
    console.error(error);
  }
}

/**
 * handle error logs AR
 */
async function createARFailedRecords(
  connections,
  item,
  error,
  dbname
) {
  try {
    const formatData = {
      source_system: item?.source_system ?? null,
      file_nbr: item?.file_nbr ?? null,
      customer_id: item?.customer_id ?? null,
      subsidiary: item?.subsidiary ?? null,
      invoice_nbr: item?.invoice_nbr ?? null,
      invoice_date:
        item?.invoice_date && moment(item?.invoice_date).isValid()
          ? moment(item?.invoice_date).format("YYYY-MM-DD HH:mm:ss")
          : null,
      housebill_nbr: item?.housebill_nbr ?? null,
      master_bill_nbr: item?.master_bill_nbr ?? null,
      invoice_type: item?.invoice_type ?? null,
      controlling_stn: item?.controlling_stn ?? null,
      charge_cd: item?.charge_cd ?? null,
      total: item?.total ?? null,
      curr_cd: item?.curr_cd ?? null,
      posted_date:
        item?.posted_date && moment(item?.posted_date).isValid()
          ? moment(item?.posted_date).format("YYYY-MM-DD HH:mm:ss")
          : null,
      gc_code: item?.gc_code ?? null,
      tax_code: item?.tax_code ?? null,
      unique_ref_nbr: item?.unique_ref_nbr ?? null,
      internal_ref_nbr: item?.internal_ref_nbr ?? null,
      order_ref: item?.order_ref?.replace(/'/g, '`') ?? null,
      ee_invoice: item?.ee_invoice ?? null,
      intercompany: item?.intercompany ?? null,
      error_msg: error?.msg + " Subsidiary: " + item?.subsidiary,
      payload: null,
      response: error?.response ?? null,
      is_report_sent: "N",
      current_dt: moment().format("YYYY-MM-DD"),
    };

    let tableStr = "";
    let valueStr = "";
    let objKyes = Object.keys(formatData);
    objKyes.map((e, i) => {
      if (i > 0) {
        valueStr += ",";
      }
      valueStr += "'" + formatData[e] + "'";
    });
    tableStr = objKyes.join(",");

   
    const query = `INSERT INTO ${dbname}interface_ar_api_logs (${tableStr}) VALUES (${valueStr});`;
    console.info("query",query);
    await connections.execute(query);

  } catch (error) {
    console.info("createARFailedRecords:error", error);
  }
}

/**
 * handle error logs AP
 */
async function createAPFailedRecords(
  connections,
  item,
  error,
  dbname
) {
  try {
    const formatData = {
      source_system: item?.source_system ?? null,
      file_nbr: item?.file_nbr ?? null,
      vendor_id: item?.vendor_id ?? null,
      subsidiary: item?.subsidiary ?? null,
      invoice_nbr: item?.invoice_nbr ?? null,
      invoice_date:
        item?.invoice_date && moment(item?.invoice_date).isValid()
          ? moment(item?.invoice_date).format("YYYY-MM-DD HH:mm:ss")
          : null,
      housebill_nbr: item?.housebill_nbr ?? null,
      master_bill_nbr: item.master_bill_nbr ?? null,
      invoice_type: item?.invoice_type ?? null,
      controlling_stn: item.controlling_stn ?? null,
      system_id: item.system_id ?? null,
      epay_status: item.status ?? null,
      currency: item?.currency ?? null,
      charge_cd: item?.charge_cd ?? null,
      total: item?.total ?? null,
      posted_date:
        item?.posted_date && moment(item?.posted_date).isValid()
          ? moment(item?.posted_date).format("YYYY-MM-DD HH:mm:ss")
          : null,
      gc_code: item.gc_code ?? null,
      tax_code: item.tax_code ?? null,
      unique_ref_nbr: item.unique_ref_nbr ?? null,
      internal_ref_nbr: item.internal_ref_nbr ?? null,
      intercompany: item?.intercompany ?? null,
      error_msg: error?.msg + " Subsidiary: " + item.subsidiary,
      payload: null,
      response: error?.response ?? null,
      is_report_sent: "N",
      current_dt: moment().format("YYYY-MM-DD"),
    };

    let tableStr = "";
    let valueStr = "";
    let objKyes = Object.keys(formatData);
    objKyes.map((e, i) => {
      if (i > 0) {
        valueStr += ",";
      }
      valueStr += "'" + formatData[e] + "'";
    });
    tableStr = objKyes.join(",");

    const query = `INSERT INTO ${dbname}interface_ap_api_logs (${tableStr}) VALUES (${valueStr});`;
    await connections.execute(query);
    
  } catch (error) {
    console.info("createAPFailedRecords:error", error);
  }
}

/**
 * handle error logs Intercompany
 */
async function createIntercompanyFailedRecords(connections, item, error) {
  try {
    const formatData = {
      source_system: item.source_system,
      invoice_type: item.invoice_type,
      file_nbr: item.file_nbr,
      ar_internal_id: item.ar_internal_id,
      ap_internal_id: item.ap_internal_id,
      error_msg: error.data.message ?? "Intercomapny API Failed",
      is_report_sent: "N",
      current_dt: moment().format("YYYY-MM-DD"),
    };

    let tableStr = "";
    let valueStr = "";
    let objKyes = Object.keys(formatData);
    objKyes.map((e, i) => {
      if (i > 0) {
        valueStr += ",";
      }
      valueStr += "'" + formatData[e] + "'";
    });
    tableStr = objKyes.join(",");

    const query = `INSERT INTO ${dbname}interface_intercompany_api_logs (${tableStr}) VALUES (${valueStr});`;
    console.info("query",query);
    await connections.query(query);
  } catch (error) {
    console.error("createIntercompanyFailedRecords:error", error);
  }
}

/**
 * handle error logs Intera-company
 */
async function createIntracompanyFailedRecords(connections,source_system, item, error) {
  try {
    const formatData = {
      source_system: source_system,
      invoice_nbr: item?.[0].invoice_nbr,
      housebill_nbr: item?.[0].housebill_nbr,
      error_msg: error.msg.replace(/"/g, "`"),
      response: error.response,
      is_report_sent: "N",
      current_dt: moment().format("YYYY-MM-DD"),
    };

    let tableStr = "";
    let valueStr = "";
    let objKyes = Object.keys(formatData);
    objKyes.map((e, i) => {
      if (i > 0) {
        valueStr += ",";
      }
      valueStr += "'" + formatData[e] + "'";
    });
    tableStr = objKyes.join(",");

    const query = `INSERT INTO ${dbname}interface_intracompany_api_logs (${tableStr}) VALUES (${valueStr});`;
    await connections.query(query);
  } catch (error) {
    console.info("createIntercompanyFailedRecords:error", error);
  }
}

/**
 * send report lambda trigger function
 */
async function triggerReportLambda(functionName, payloadData) {
  try {
    const params = {
      FunctionName: functionName,
      Payload: JSON.stringify({ invPayload: payloadData }, null, 2),
    };

    const data = await lambda.invoke(params).promise();

    if (data.Payload) {
      console.info(data.Payload);
      return 'success';
    } else {
      console.info('unable to send report');
      return 'failed';
    }
  } catch (error) {
    console.info('error:triggerReportLambda', error);
    console.info('unable to send report');
    return 'failed';
  }
}


async function sendDevNotification(
  sourceSystem,
  invType,
  apiName,
  invoiceData,
  error
) {
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

    const message = {
      from: `Netsuite <${process.env.NETSUIT_AR_ERROR_EMAIL_FROM}>`,
      to: process.env.NETSUIT_AR_ERROR_EMAIL_TO,
      subject: `Netsuite ${process.env.STAGE.toUpperCase()} Error ${sourceSystem} - ${invType} - ${process.env.STAGE.toUpperCase()}`,
      html: `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta http-equiv="X-UA-Compatible" content="IE=edge">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Netsuite Error</title>
      </head>
      <body>
        <h3>Error:- ${sourceSystem} - ${invType} - ${apiName} </h3>

        <p> Source System:- ${sourceSystem ?? ""}</p> 
        <p> Invoice Type:- ${invType ?? ""}</p> 
        <p> Invoice Data:- </p> <pre>${JSON.stringify(
          invoiceData,
          null,
          4
        )}</pre>
        <p> Error:- </p> <pre>${JSON.stringify(error, null, 4)}</pre>
      </body>
      </html>
      `,
    };

    await transporter.sendMail(message);
    return true;
  } catch (error) {
    return false;
  }
}


function getAuthorizationHeader(options) {
  const crypto = require("crypto");
  const OAuth = require("oauth-1.0a");

  const oauth = OAuth({
    consumer: {
      key: options.consumer_key,
      secret: options.consumer_secret_key,
    },
    realm: options.realm,
    signature_method: "HMAC-SHA256",
    hash_function(base_string, key) {
      return crypto
        .createHmac("sha256", key)
        .update(base_string)
        .digest("base64");
    },
  });
  return oauth.toHeader(
    oauth.authorize(
      {
        url: options.url,
        method: options.method,
      },
      {
        key: options.token,
        secret: options.token_secret,
      }
    )
  );
}

function setDelay(sec) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      resolve(true);
    }, sec * 500);
  });
}

module.exports = {
  getConfig,
  getConnectionToRds,
  createARFailedRecords,
  createAPFailedRecords,
  createIntercompanyFailedRecords,
  triggerReportLambda,
  sendDevNotification,
  createIntracompanyFailedRecords,
  getAuthorizationHeader,
  setDelay,
};
