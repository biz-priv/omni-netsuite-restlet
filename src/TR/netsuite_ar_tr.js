const AWS = require("aws-sdk");
const crypto = require("crypto");
const OAuth = require("oauth-1.0a");
const axios = require("axios");
const {
  getConfig,
  getConnectionToRds,
  createARFailedRecords,
  triggerReportLambda,
  sendDevNotification,
} = require("../../Helpers/helper");
const { getBusinessSegment } = require("../../Helpers/businessSegmentHelper");

let userConfig = "";
let connections = "";

const arDbNamePrev = process.env.DATABASE_NAME;
const arDbName = arDbNamePrev + "interface_ar";
const source_system = "TR";
let totalCountPerLoop = 20;
const today = getCustomDate();

module.exports.handler = async (event, context, callback) => {
  userConfig = getConfig(source_system, process.env);
  let hasMoreData = "false";
  let currentCount = 0;
  totalCountPerLoop = event.hasOwnProperty("totalCountPerLoop")
    ? event.totalCountPerLoop
    : totalCountPerLoop;

  try {
    /**
     * Get connections
     */
    connections = await getConnectionToRds(process.env);

    /**
     * Get data from db
     */
    const orderData = await getDataGroupBy(connections);

    console.info("orderData", orderData.length);
    const invoiceIDs = orderData.map((a) => "'" + a.invoice_nbr + "'");
    console.info("invoiceIDs", invoiceIDs);

    currentCount = orderData.length;
    const invoiceDataList = await getInvoiceNbrData(connections, invoiceIDs);
    console.info("invoiceDataList", invoiceDataList.length);

    /**
     * 5 simultaneous process
     */
    const perLoop = 15;
    let queryData = [];
    for (let index = 0; index < (orderData.length + 1) / perLoop; index++) {
      let newArray = orderData.slice(
        index * perLoop,
        index * perLoop + perLoop
      );

      const data = await Promise.all(
        newArray.map(async (item) => {
          return await mainProcess(item, invoiceDataList);
        })
      );
      queryData = [...queryData, ...data];
    }


    await updateInvoiceId(connections, queryData);

    if (currentCount > totalCountPerLoop) {
      hasMoreData = "true";
    } else {
      await triggerReportLambda(process.env.NS_RESTLET_INVOICE_REPORT, "TR_AR");
      await startNextStep();
      hasMoreData = "false";
    }
    return { hasMoreData };
  } catch (error) {
    await triggerReportLambda(process.env.NS_RESTLET_INVOICE_REPORT, "TR_AR");
    await startNextStep();
    return { hasMoreData: "false" };
  }
};

/**
 * main process of netsuite AR API
 * @param {*} connections
 * @param {*} item
 */
async function mainProcess(item, invoiceDataList) {
  let singleItem = null;
  try {
    /**
     * get invoice obj from DB
     */
    const dataList = invoiceDataList.filter((e) => {
      return (
        e.invoice_nbr == item.invoice_nbr &&
        e.customer_id == item.customer_id &&
        e.invoice_type == item.invoice_type &&
        e.gc_code == item.gc_code
      );
    });

    singleItem = dataList[0];

    /**
     * Make Json payload
     */
    const jsonPayload = await makeJsonPayload(dataList);


    /**
     * create Netsuit Invoice
     */
    const invoiceId = await createInvoice(jsonPayload, singleItem);
    console.info("invoiceId", invoiceId);

    /**
     * update invoice id
     */
    const getQuery = getUpdateQuery(singleItem, invoiceId);
    return getQuery;
  } catch (error) {
    console.error("error:process", error);
    if (error.hasOwnProperty("customError")) {
      let getQuery = "";
      try {
        getQuery = getUpdateQuery(singleItem, null, false);
        await createARFailedRecords(
          connections,
          singleItem,
          error,
          arDbNamePrev
        );
        return getQuery;
      } catch (error) {
        await createARFailedRecords(
          connections,
          singleItem,
          error,
          arDbNamePrev
        );
        return getQuery;
      }
    }
  }
}

async function getDataGroupBy(connections) {
  try {
    const query = `SELECT distinct invoice_nbr,customer_id,invoice_type, gc_code FROM ${arDbName}
    where source_system = '${source_system}' and customer_internal_id is not null and invoice_nbr is not null
    and ((internal_id is null and processed is null) or (processed='F' and processed_date < '${today}'))
    and ((intercompany='Y' and pairing_available_flag ='Y') or intercompany='N')
    order by invoice_nbr,customer_id,invoice_type, gc_code
    limit ${totalCountPerLoop + 1}`;

    console.info("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.error("error", error);
    throw "No data found.";
  }
}

async function getInvoiceNbrData(connections, invoice_nbr) {
  try {
    const query = `select * from ${arDbName} where source_system = '${source_system}' 
    and invoice_nbr in (${invoice_nbr.join(",")})`;
    console.info("query", query);

    const executeQuery = await connections.execute(query);
    const result = executeQuery[0];
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.error("error");
    throw "No data found.";
  }
}

async function makeJsonPayload(data) {
  try {
    const singleItem = data[0];
    const hardcode = getHardcodeData(
      singleItem.intercompany == "Y" ? true : false
    );

    /**
     * head level details
     */
    const payload = {
      custbodytmsdebtorcreditorid: singleItem.bill_to_nbr ?? "",
      custbody_mfc_omni_unique_key:
        singleItem.invoice_nbr +
        "-" +
        singleItem.customer_id +
        "-" +
        singleItem.invoice_type +
        "-" +
        singleItem.gc_code, //invoice_nbr, customer_id, invoice_type, gc_code
      tranid: singleItem.invoice_nbr ?? "",
      trandate: singleItem.invoice_date
        ? dateFormat(singleItem.invoice_date)
        : null,
      department: hardcode.department.head,
      class: hardcode.class.head,
      location: hardcode.location.head,
      custbody_source_system: hardcode.source_system,//2327
      custbodymfc_tmsinvoice: singleItem.invoice_nbr ?? "",
      entity: singleItem.customer_internal_id ?? "",
      subsidiary: singleItem.subsidiary ?? "",
      currency: singleItem.currency_internal_id ?? "",
      otherrefnum: singleItem.order_ref ?? "",//1730
      custbody_mode: singleItem?.mode_name ?? "",//2673
      custbody_service_level: singleItem?.service_level ?? "",//2674
      custbody18: singleItem.finalized_date ?? "",//1745
      custbody9: singleItem.file_nbr ?? "",//1730 
      custbody17: singleItem.email ?? "",//1744
      custbody25: singleItem.zip_code ?? "",//2698
      custbodyee_invno: singleItem.ee_invoice ?? "",
      memo: singleItem.housebill_nbr ?? "",
      custbody27: singleItem.rfiemail ?? "",//dev :custbody29 prod: custbody27
      item: data.map((e) => {
        return {
          item: e.charge_cd_internal_id ?? "",
          ...(e.tax_code_internal_id ?? "" !== "" ? { taxcode: e.tax_code_internal_id } : {}),
          description: e?.charge_cd_desc ?? "",
          amount: +parseFloat(e.total).toFixed(2) ?? "",
          rate: +parseFloat(e.rate).toFixed(2) ?? "",
          department: hardcode.department.line ?? "",
          class:
            hardcode.class.line[
            e.business_segment.split(":")[1].trim().toLowerCase()
            ],
          location: {
            refName: e.handling_stn ?? "",
          },
          custcol_hawb: e.housebill_nbr ?? "",//760
          custcol3: e.sales_person ?? "",//1167
          custcol5: e.master_bill_nbr ?? "",//1727
          custcol2: {
            refName: e.controlling_stn ?? "",//1166
          },
          custcol1: e.ready_date ? e.ready_date.toISOString() : "",//1164
          custcol_actual_weight: e.actual_weight ?? "",//dev: custcol20  prod: custcol_actual_weight
          custcol_destination_on_zip: e.dest_zip ?? "",//dev: custcol19 prod: custcol_destination_on_zip
          custcol_destination_on_state: e.dest_state ?? "",//dev: custcol18 prod: custcol_destination_on_state
          custcol_destination_on_country: e.dest_country ?? "",//dev: custcol17 prod: custcol_destination_on_country
          custcol_miles_distance: e.miles ?? "",
          custcol_chargeable_weight: e.chargeable_weight ?? "",
        };
      }),
    };

    console.info("payload", JSON.stringify(payload));
    return payload;
  } catch (error) {
    console.error("error payload", error);
    await sendDevNotification(
      source_system,
      "AR",
      "netsuite_ar_tr payload error",
      data[0],
      error
    );
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



async function createInvoice(payload, singleItem) {
  try {
    const endpoiont =
      singleItem.invoice_type == "IN"
        ? process.env.NETSUIT_RESTLET_INV_URL
        : process.env.NETSUIT_RESTLET_CM_URL;

    const options = {
      consumer_key: userConfig.token.consumer_key,
      consumer_secret_key: userConfig.token.consumer_secret,
      token: userConfig.token.token_key,
      token_secret: userConfig.token.token_secret,
      realm: userConfig.account,
      url: endpoiont,
      method: 'POST',
    };

    const authHeader = getAuthorizationHeader(options);

    const configApi = {
      method: options.method,
      maxBodyLength: Infinity,
      url: options.url,
      headers: {
        'Content-Type': 'application/json',
        ...authHeader,
      },
      data: JSON.stringify(payload),
    };


    const response = await axios.request(configApi);
    console.info("response", response.status);

    if (response.status === 200 && response.data.status === 'Success') {
      return response.data.id;
    } else {
      throw {
        customError: true,
        msg: response.data.reason.replace(/'/g, '`'),
        payload: JSON.stringify(payload),
        response: response.data,
      };
    }
  } catch (error) {
    console.error("createInvoice:error", error);
    if (error?.response?.reason) {
      throw {
        customError: true,
        msg: error.msg.replace(/'/g, '`'),
        payload: error.payload,
        response: JSON.stringify(error.response).replace(/'/g, '`'),
      };
    } else {
      throw {
        customError: true,
        msg: 'Netsuit AR Api Failed',
        response: '',
      };
    }
  }
}




function getUpdateQuery(item, invoiceId, isSuccess = true) {
  try {
    console.info("invoice_nbr ", item.invoice_nbr, invoiceId);
    let query = `UPDATE ${arDbName} `;
    if (isSuccess) {
      query += ` SET internal_id = '${invoiceId}', processed = 'P', `;
    } else {
      query += ` SET internal_id = null, processed = 'F', `;
    }
    query += `processed_date = '${today}' 
              WHERE source_system = '${source_system}' and invoice_nbr = '${item.invoice_nbr}' 
              and invoice_type = '${item.invoice_type}' and customer_id = '${item.customer_id}' 
              and gc_code = '${item.gc_code}';`;
    console.info("query", query);
    return query;
  } catch (error) {
    console.error("error:getUpdateQuery", error, item, invoiceId);
    return "";
  }
}

async function updateInvoiceId(connections, query) {
  for (let index = 0; index < query.length; index++) {
    const element = query[index];
    try {
      await connections.execute(element);
    } catch (error) {
      console.error("error:updateInvoiceId", error);
      await sendDevNotification(
        source_system,
        "AR",
        "netsuite_ar_tr updateInvoiceId",
        "Invoice is created But failed to update internal_id " + element,
        error
      );
    }
  }
}

function getHardcodeData(isIntercompany = false) {
  const data = {
    source_system: "1",
    class: {
      head: "9",
      line: getBusinessSegment(process.env.STAGE),
    },
    department: {
      default: { head: "15", line: "1" },
      intercompany: { head: "16", line: "1" },
    },
    location: { head: "18", line: "EXT ID: Take from DB" },
  };
  const departmentType = isIntercompany ? "intercompany" : "default";
  return {
    ...data,
    department: data.department[departmentType],
  };
}

function dateFormat(param) {
  try {
    const date = new Date(param);
    return (
      date.getFullYear() +
      "-" +
      ("00" + (date.getMonth() + 1)).slice(-2) +
      "-" +
      ("00" + date.getDate()).slice(-2) +
      "T11:05:03.000Z"
    );
  } catch (error) {
    return null;
  }
}

function getCustomDate() {
  const date = new Date();
  let ye = new Intl.DateTimeFormat("en", { year: "numeric" }).format(date);
  let mo = new Intl.DateTimeFormat("en", { month: "2-digit" }).format(date);
  let da = new Intl.DateTimeFormat("en", { day: "2-digit" }).format(date);
  return `${ye}-${mo}-${da}`;
}


async function startNextStep() {
  try {
    const params = {
      stateMachineArn: process.env.NETSUITE_VENDOR_STEP_ARN,
      input: JSON.stringify({}),
    };
    const stepfunctions = new AWS.StepFunctions();
    const data = await new Promise((resolve, reject) => {
      stepfunctions.startExecution(params, (err, data) => {
        if (err) {
          console.info("Netsuit NETSUITE_VENDOR_STEP_ARN trigger failed");
          reject(err);
        } else {
          console.info("Netsuit NETSUITE_VENDOR_STEP_ARN started");
          resolve(data);
        }
      });
    });

    return true;
  } catch (error) {
    console.error("Error in startNextStep:", error);
    return false;
  }
}