const AWS = require("aws-sdk");
const axios = require("axios");
const crypto = require("crypto");
const OAuth = require("oauth-1.0a");
const {
  getConfig,
  triggerReportLambda,
  sendDevNotification,
  getConnectionToRds,
  createIntracompanyFailedRecords,
} = require("../../Helpers/helper");
const { getBusinessSegment } = require("../../Helpers/businessSegmentHelper");

let userConfig = "";
let connections = "";

const today = getCustomDate();
const totalCountPerLoop = 0;

const source_system = "WT";
const arDbNamePrev = process.env.DATABASE_NAME;;
const apDbName = arDbNamePrev + "interface_ap_crossdock_stage";

module.exports.handler = async (event, context, callback) => {
  userConfig = getConfig(source_system, process.env);
//   const checkIsRunning = await checkOldProcessIsRunning();
//   if (checkIsRunning) {
//     return {
//       hasMoreData: "false",
//     };
//   }
  let hasMoreData = "false";
  let currentCount = 0;
  try {
    /**
     * Get connections
     */
    connections = await getConnectionToRds(process.env);

    /**
     * Get invoice internal ids from
     */
    const invoiceData = await getUniqueRecords();

    console.info("invoiceData", invoiceData.length);
    currentCount = invoiceData.length;

    for (let i = 0; i < invoiceData.length; i++) {
      const item = invoiceData[i];

      const records = await getRecordDetails(item);
      console.log("🚀 ~ module.exports.handler= ~ records:", records)

      await mainProcess(item.source_system, records);
      console.info("count", i + 1);
    }

    if (currentCount > totalCountPerLoop) {
      hasMoreData = "true";
    } else {
        // await triggerReportLambda(
        //   process.env.NETSUIT_INVOICE_REPORT,
        //   `${source_system}_INTRACOMPANY`
        // );
      hasMoreData = "false";
    }
    return { hasMoreData };
  } catch (error) {
    console.error("error:handler", error);
    //   await triggerReportLambda(
    //     process.env.NETSUIT_INVOICE_REPORT,
    //     `${source_system}_INTRACOMPANY`
    //   );
    return { hasMoreData: "false" };
  }
};

/**
 * get data
 * @param {*} connections
 */
async function getUniqueRecords() {
  try {
    // const query = `select distinct ap.file_nbr from ${apDbName} ap limit 1`
    const query = `select distinct ap.file_nbr
        from ${apDbName} ap
        where (
                (ap.internal_id is null and ap.processed is null)
                or
                (ap.processed ='F' and ap.processed_date <= '${today}')
              ) and ap.source_system = '${source_system}'
        limit ${totalCountPerLoop + 1}`;

    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.error("error:getData", error);
    throw "No data found.";
  }
}

async function getRecordDetails(item) {
  try {
    const query = `select * from (select source_system,file_nbr as invoice_nbr,file_nbr ,id,subsidiary,currency ,master_bill_nbr,
        housebill_nbr,internal_ref_nbr as consol_housebill_nbr,business_segment,handling_stn,charge_cd,charge_cd_desc ,
        charge_cd_internal_id,sales_person,invoice_date ,email ,finalizedby,
        rate as debit,null as credit,'40040' as account_num
        from ${apDbName}
        union
        select source_system,file_nbr as invoice_nbr,file_nbr ,id,subsidiary,currency ,master_bill_nbr,
        housebill_nbr,internal_ref_nbr as consol_housebill_nbr,business_segment,vendor_id as handling_stn,charge_cd,charge_cd_desc ,
        charge_cd_internal_id,sales_person,invoice_date ,email ,finalizedby,
        null as debit,rate as credit,'40040' as account_num
        from ${apDbName} ) a where a.file_nbr = '5927541/A'`;

    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.error("error:getData", error);
    throw "No data found.";
  }
}

async function mainProcess(source_system, item) {
  try {
    const payload = await makeJsonPayload(item);
    console.log("🚀 ~ mainProcess ~ payload:", JSON.stringify(payload))
    const internalId = await createInvoice(payload);
    console.log("🚀 ~ mainProcess ~ internalId:", internalId)
    return

    // await updateAPandAr(item, internalId);
  } catch (error) {
    console.error("error:mainProcess", error);
    if (error.hasOwnProperty("customError")) {
      await updateAPandAr(item, null, "F");
      await createIntracompanyFailedRecords(connections, source_system, item, error);
    }
  }
}

async function makeJsonPayload(data) {
  try {
    const bgs = getBusinessSegment(process.env.STAGE);
    const acc_internal_ids = {
      40040: 326,
    };

    /**
     * head level details
     */
    const singleItem = data[0];
    console.log("🚀 ~ makeJsonPayload ~ singleItem:", singleItem)

    const payload = {
      custbody_mfc_omni_unique_key:
        singleItem.invoice_nbr + "-" + singleItem.housebill_nbr,
      trandate: singleItem.invoice_date,
      subsidiary: singleItem.subsidiary,
      currency: {
        refName: singleItem.currency,
      },
      custcol4: singleItem.housebill_nbr,
      line: data.map((e) => {
        return {
          custcol_mfc_line_unique_key: e.account_num + "-" + e.id, 
          account: acc_internal_ids[e.account_num],
          debit: e.debit ?? 0,
          credit: e.credit ?? 0,
          memo: e.charge_cd_desc ?? "",
          custcol4: e.housebill_nbr ?? "",
          department: "1",
          class: bgs[e.business_segment.split(":")[1].trim().toLowerCase()],
          location: { refName: e.handling_stn },
          custcol3: e.sales_person ?? "",
          custcol5: e.master_bill_nbr ?? "",
          custcol_finalizedby: e.finalizedby ?? "",
          custbody17: e.email ?? "",
        };
      }),
    };

    return payload;
  } catch (error) {
    console.error("error payload", error);
    throw {
      customError: true,
      msg: "Unable to make payload",
      data: data[0],
    };
  }
}

function getAuthorizationHeader(options) {
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

function createInvoice(payload) {
  return new Promise((resolve, reject) => {
    try {
      const options = {
        consumer_key: userConfig.token.consumer_key,
        consumer_secret_key: userConfig.token.consumer_secret,
        token: userConfig.token.token_key,
        token_secret: userConfig.token.token_secret,
        realm: userConfig.account,
        url: process.env.NETSUIT_INTRACOMPANY_URL,
        method: "POST",
      };
      const authHeader = getAuthorizationHeader(options);

      const configApi = {
        method: options.method,
        maxBodyLength: Infinity,
        url: options.url,
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
        data: JSON.stringify(payload),
      };

      axios
        .request(configApi)
        .then((response) => {
          console.error(JSON.stringify(response.data));
          if (response.status === 200 && response.data.status === "Success") {
            resolve(response.data.id);
          } else {
            reject({
              customError: true,
              msg: response.data.reason.replace(/'/g, "`"),
              payload: JSON.stringify(payload),
              response: JSON.stringify(response.data).replace(/'/g, "`"),
            });
          }
        })
        .catch((error) => {
          console.error(error.response.data);
          reject({
            customError: true,
            msg: error.response.data.reason.replace(/'/g, "`"),
            payload: JSON.stringify(payload),
            response: JSON.stringify(error.response.data).replace(/'/g, "`"),
          });
        });
    } catch (error) {
      console.error("error:createInvoice:main:catch", error);
      reject({
        customError: true,
        msg: "Netsuit AR Api Failed",
        response: "",
      });
    }
  });
}

/**
 * Update data
 * @param {*} connections
 * @param {*} item
 */
async function updateAPandAr(item, internal_id, processed = "P") {
  try {
    const query = `
                  UPDATE ${apDbName} set 
                  processed = '${processed}', 
                  processed_date = '${today}',
                  internal_id = ${internal_id == null ? null : "'" + internal_id + "'"
      }
                  where invoice_nbr = '${item[0].invoice_nbr}' or 
                  housebill_nbr = '${item[0].housebill_nbr}';
                `;
    console.info("query", query);
    await connections.query(query);
  } catch (error) {
    console.error("error:updateAPandAr", error);
    await sendDevNotification(
      "WT-CROSSDOCK",
      "WT",
      "netsuite_wt_crossdock updateAPandAr",
      item,
      error
    );
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
  return new Promise((resolve, reject) => {
    try {
      //intracompany arn
      const intracompany = process.env.NETSUITE_INTRACOMPANY_ARN;
      const status = "RUNNING";
      const stepfunctions = new AWS.StepFunctions();
      stepfunctions.listExecutions(
        {
          stateMachineArn: intracompany,
          statusFilter: status,
          maxResults: 2,
        },
        (err, data) => {
          console.info(" Intracompany listExecutions data", data);
          const venExcList = data.executions;
          if (
            err === null &&
            venExcList.length == 2 &&
            venExcList[1].status === status
          ) {
            console.info("Intracompany running");
            resolve(true);
          } else {
            resolve(false);
          }
        }
      );
    } catch (error) {
      resolve(true);
    }
  });
}
