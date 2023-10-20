const AWS = require("aws-sdk");
const axios = require("axios");
const crypto = require("crypto");
const OAuth = require("oauth-1.0a");
const {
  getConnectionToRds,
  createIntercompanyFailedRecords,
  triggerReportLambda,
  sendDevNotification,
} = require("../Helpers/helper");

const userConfig = {
  account: process.env.NETSUIT_AR_ACCOUNT,
  apiVersion: "2021_2",
  realm: process.env.NETSUIT_AR_ACCOUNT,
  signature_method: "HMAC-SHA256",
  token: {
    consumer_key: process.env.NETSUIT_AR_CONSUMER_KEY,
    consumer_secret: process.env.NETSUIT_AR_CONSUMER_SECRET,
    token_key: process.env.NETSUIT_TR_TOKEN_KEY,
    token_secret: process.env.NETSUIT_TR_TOKEN_SECRET,
  },
};
const today = getCustomDate();
const totalCountPerLoop = 5;
const source_system = "TR";
const dbname = process.env.DATABASE_NAME;
const arDbName = dbname + "interface_ar";
const apDbName = dbname + "interface_ap";

module.exports.handler = async (event, context, callback) => {
  const checkIsRunning = await checkOldProcessIsRunning();
  if (checkIsRunning) {
    return {
      hasMoreData: "false",
    };
  }

  let hasMoreData = "false";
  let currentCount = 0;
  try {
    /**
     * Get connections
     */
    const connections = await getConnectionToRds(process.env) ;
    /**
     * Get invoice internal ids from ${apDbName} and ${arDbName}
     */
    const invoiceData = await getData(connections);
    console.info("invoiceData", invoiceData.length);
    currentCount = invoiceData.length;

    for (let i = 0; i < invoiceData.length; i++) {
      const item = invoiceData[i];
      await mainProcess(connections, item);
      console.info("count", i + 1);
    }

    if (currentCount > totalCountPerLoop) {
      hasMoreData = "true";
    } else {
      await triggerReportLambda(
        process.env.NS_RESTLET_INVOICE_REPORT,
        "TR_INTERCOMPANY"
      );
      hasMoreData = "false";
    }
    return { hasMoreData };
  } catch (error) {
    console.error("error:handler", error);
    await triggerReportLambda(
      process.env.NS_RESTLET_INVOICE_REPORT,
      "TR_INTERCOMPANY"
    );
    return { hasMoreData: "false" };
  }
};

/**
 * get data
 * @param {*} connections
 */
async function getData(connections) {
  try {
    const query = `
    select distinct ar.source_system , ar.file_nbr , ar.ar_internal_id , ap.ap_internal_id, ap.invoice_type
    from (select distinct source_system ,file_nbr ,invoice_nbr ,invoice_type ,unique_ref_nbr,internal_id as ar_internal_id ,total
        from ${arDbName} ia
          where source_system = '${source_system}' and intercompany = 'Y' and pairing_available_flag = 'Y' and processed = 'P' and (intercompany_processed_date is null or
            (intercompany_processed = 'F' and intercompany_processed_date < '${today}'))
        )ar
    join
        (
        select distinct a.source_system ,a.file_nbr ,a.invoice_nbr ,a.invoice_type ,a.unique_ref_nbr ,a.internal_id as ap_internal_id,total
            from ${apDbName} a
            where source_system = '${source_system}' and intercompany = 'Y' and pairing_available_flag = 'Y' and processed = 'P' and (intercompany_processed_date is null or
                        (intercompany_processed = 'F' and intercompany_processed_date < '${today}'))
        )ap
    on ar.source_system = ap.source_system
    and ar.file_nbr = ap.file_nbr
    and ar.invoice_type = ap.invoice_type
    and ar.unique_ref_nbr = ap.unique_ref_nbr
    limit ${totalCountPerLoop + 1}`;
    console.info("query",query);
    const [rows] = await connections.execute(query);
    const result = rows
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.error("error:getData", error);
    throw "No data found.";
  }
}

/**
 * Update data
 * @param {*} connections
 * @param {*} item
 */
async function updateAPandAr(connections, item, processed = "P") {
  try {
    console.info(
      "updateAPandAr",
      "AP " + item.ap_internal_id,
      "AR " + item.ar_internal_id,
      processed
    );
    const query1 = `
                UPDATE ${apDbName} set 
                intercompany_processed = '${processed}', 
                intercompany_processed_date = '${today}'
                where internal_id = '${item.ap_internal_id}' and source_system = '${source_system}';
                `;
    console.info("query1", query1);
    await connections.query(query1);
    const query2 = `
                UPDATE ${arDbName} set 
                intercompany_processed = '${processed}', 
                intercompany_processed_date = '${today}'
                where internal_id = '${item.ar_internal_id}' and source_system = '${source_system}';
              `;
    console.info("query2", query2);
    await connections.query(query2);
  } catch (error) {
    console.error("error:updateAPandAr", error);
    await sendDevNotification(
      "INVOICE-INTERCOMPANY",
      "TR",
      "netsuite_intercompany updateAPandAr",
      item,
      error
    );
  }
}

async function mainProcess(connections, item) {
  try {
    await createInterCompanyInvoice(item);
    await updateAPandAr(connections, item);
  } catch (error) {
    console.error("error:mainProcess", error);
    if (error.hasOwnProperty("customError")) {
      await updateAPandAr(connections, item, "F");
      await createIntercompanyFailedRecords(connections, item, error);
    } else {
      await sendDevNotification(
        "INVOICE-INTERCOMPANY",
        "TR",
        "netsuite_intercompany mainProcess",
        item,
        error
      );
    }
  }
}

async function createInterCompanyInvoice(item) {
  const apInvoiceId = item.ap_internal_id;
  const arInvoiceId = item.ar_internal_id;
  const transactionType = item.invoice_type == "IN" ? "invoice" : "creditmemo";
  try {
    const baseUrl = process.env.NETSUITE_INTERCOMPANY_BASE_URL;
    const url = `${baseUrl}&iid1=${arInvoiceId}&iid2=${apInvoiceId}&transactionType=${transactionType}`;
    const authHeader = getAuthorizationHeader(url);
    const headers = {
      ...authHeader,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const res = await axios.get(url, { headers });
    if (res.data.status == "Success") {
      return true;
    } else {
      throw {
        data: res.data,
      };
    }
  } catch (error) {
    console.error("error:createInterCompanyInvoice", error);
    throw {
      customError: true,
      arInvoiceId,
      apInvoiceId,
      transactionType,
      data: error?.data ?? error?.response?.data,
    };
  }
}

function getAuthorizationHeader(url) {
  try {
    const oauth = OAuth({
      consumer: {
        key: userConfig.token.consumer_key,
        secret: userConfig.token.consumer_secret,
      },
      realm: userConfig.realm,
      signature_method: userConfig.signature_method,
      hash_function: (base_string, key) =>
        crypto.createHmac("sha256", key).update(base_string).digest("base64"),
    });
    return oauth.toHeader(
      oauth.authorize(
        {
          url: url,
          method: "get",
        },
        {
          key: userConfig.token.token_key,
          secret: userConfig.token.token_secret,
        }
      )
    );
  } catch (error) {
    throw error;
  }
}

function getCustomDate() {
  const date = new Date();
  let ye = new Intl.DateTimeFormat("en", { year: "numeric" }).format(date);
  let mo = new Intl.DateTimeFormat("en", { month: "2-digit" }).format(date);
  let da = new Intl.DateTimeFormat("en", { day: "2-digit" }).format(date);
  return `${ye}-${mo}-${da}`;
}

async function checkOldProcessIsRunning() {
  try {
    const intercompanyArn = process.env.NETSUITE_INTERCOMPANY_ARN;
    const status = "RUNNING";
    const stepfunctions = new AWS.StepFunctions();

    const data = await stepfunctions.listExecutions({
      stateMachineArn: intercompanyArn,
      statusFilter: status,
      maxResults: 2,
    }).promise();

    console.info("Intercompany listExecutions data", data);
    const intercomExcList = data.executions;

    if (
      data &&
      intercomExcList.length === 2 &&
      intercomExcList[1].status === status
    ) {
      console.info("Intercompany running");
      return true;
    } else {
      return false;
    }
  } catch (error) {
    return true;
  }
}