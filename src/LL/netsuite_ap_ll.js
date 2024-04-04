const AWS = require("aws-sdk");
const crypto = require("crypto");
const OAuth = require("oauth-1.0a");
const axios = require("axios");
const {
  getConfig,
  getConnectionToRds,
  createAPFailedRecords,
  triggerReportLambda,
  sendDevNotification,
} = require("../../Helpers/helper");
const { getBusinessSegment } = require("../../Helpers/businessSegmentHelper");

let userConfig = "";
let connections = "";

const apDbNamePrev = process.env.DATABASE_NAME;
const apDbName = apDbNamePrev + "interface_ap_epay";
const source_system = "LL";

const today = getCustomDate();
let currentCount = 0;
const lineItemPerProcess = 500;
let totalCountPerLoop = 20;
let queryOffset = 0;
let queryinvoiceType = "IN"; // IN / CM
let queryOperator = "<=";
let queryInvoiceId = null;
let queryInvoiceNbr = null;
let queryVendorId = null;
let processType = "";

module.exports.handler = async (event, context, callback) => {
  userConfig = getConfig(source_system, process.env);

  console.log("event", event);
  totalCountPerLoop = event.hasOwnProperty("totalCountPerLoop")
    ? event.totalCountPerLoop
    : totalCountPerLoop;
  queryOperator = event.hasOwnProperty("queryOperator")
    ? event.queryOperator
    : "<=";

  queryInvoiceId = event.hasOwnProperty("queryInvoiceId")
    ? event.queryInvoiceId
    : null;

  queryInvoiceNbr = event.hasOwnProperty("queryInvoiceNbr")
    ? event.queryInvoiceNbr
    : null;

  queryOffset = event.hasOwnProperty("queryOffset") ? event.queryOffset : 0;

  queryinvoiceType = event.hasOwnProperty("queryinvoiceType")
    ? event.queryinvoiceType
    : "IN";

  queryVendorId = event.hasOwnProperty("queryVendorId")
    ? event.queryVendorId
    : null;

  processType = event.hasOwnProperty("processType") ? event.processType : "";
  console.info("processType: ", processType);

  try {
    /**
     * Get connections
     */
    connections = await getConnectionToRds(process.env);

    if (processType == "cancellation") {
      console.log("Inside cancellation process");
      processType = await cancellationProcess();
      console.log("processType after cancellation process: ", processType);
      return {
        hasMoreData: "true",
        processType,
      };
    } else if (processType == "billPayment") {
      console.log("Inside bill payment process");
      let hasMoreData = await billPaymentProcess();
      if (hasMoreData == "false") {
        await triggerReportLambda(
          process.env.NS_RESTLET_INVOICE_REPORT,
          "LL_AP"
        );
      }
      return {
        hasMoreData,
        processType,
      };
    } else {
      //Create the main invoice with 500 line items 1st
      /**
       * Get data from db
       */
      let invoiceDataList = [];
      let orderData = [];
      let invoiceIDs = [];
      try {
        orderData = await getDataGroupBy(connections);
      } catch (error) {
        console.error("Error while fetching unique invoices: ", error);
        return {
          hasMoreData: "true",
          processType: "cancellation",
        };
      }

      try {
        invoiceIDs = orderData.map((a) => "'" + a.invoice_nbr + "'");
        console.log("orderData**", orderData.length, orderData);
        console.log("invoiceIDs", invoiceIDs);
        if (orderData.length === 1) {
          console.log("length==1", orderData);
        }
        currentCount = orderData.length;
        invoiceDataList = await getInvoiceNbrData(connections, invoiceIDs);
        console.log("invoiceDataList", invoiceDataList.length);
      } catch (error) {
        console.log("error:getInvoiceNbrData:try:catch", error);
        console.log(
          "invoiceIDs:try:catch found on getDataGroupBy but not in getInvoiceNbrData",
          invoiceIDs
        );
        return {
          hasMoreData: "true",
          processType: "cancellation",
        };
      }
      /**
       * 15 simultaneous process
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

      /**
       * Updating total 20 invoices at once
       */
      await updateInvoiceId(connections, queryData);

      if (currentCount < totalCountPerLoop) {
        processType = "cancellation";
      }
    }
    return { hasMoreData: "true", processType };
  } catch (error) {
    console.log("error", error);
    await triggerReportLambda(process.env.NS_RESTLET_INVOICE_REPORT, "LL_AP");
    return { hasMoreData: "false" };
  }
};

/**
 * main process of netsuite AP API
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
        e.vendor_id == item.vendor_id &&
        e.invoice_type == item.invoice_type &&
        e.system_id == item.system_id
      );
    });
    console.log("dataList", dataList.length);

    /**
     * set single item and customer data
     */
    singleItem = dataList[0];

    /**
     * Make Json payload
     */
    const jsonPayload = await makeJsonPayload(dataList);
    console.log("JSONPayload", JSON.stringify(jsonPayload));
    /**
     * create invoice
     */
    const invoiceId = await createInvoice(jsonPayload, singleItem);
    console.log("invoiceId", invoiceId);

    if (queryOperator == ">") {
      queryInvoiceId = invoiceId.toString();
    }

    /**
     * update invoice id
     */
    const getQuery = getUpdateQuery(singleItem, invoiceId);
    return getQuery;
  } catch (error) {
    console.log("mainprocess:error", error);
    if (error.hasOwnProperty("customError")) {
      let getQuery = "";
      try {
        getQuery = getUpdateQuery(singleItem, null, false);
        await createAPFailedRecords(
          connections,
          singleItem,
          error,
          apDbNamePrev
        );
        return getQuery;
      } catch (error) {
        await createAPFailedRecords(
          connections,
          singleItem,
          error,
          apDbNamePrev
        );
        return getQuery;
      }
    }
  }
}

/**
 * get data
 * @param {*} connections
 * @returns
 */
async function getDataGroupBy(connections) {
  try {
    const query = `SELECT invoice_nbr, vendor_id, invoice_type, system_id, count(*) as tc FROM ${apDbName} 
    WHERE  ((internal_id is null and processed is null and vendor_internal_id is not null) or
    (vendor_internal_id is not null and processed ='F' and processed_date < '${today}'))
    and source_system = '${source_system}' and invoice_nbr != '' and status='APPROVED' 
    GROUP BY invoice_nbr, vendor_id, invoice_type, system_id 
    having tc ${queryOperator} ${lineItemPerProcess} 
    limit ${totalCountPerLoop + 1}`;
    console.log("query", query, totalCountPerLoop);

    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.error("Error while fetching data: ", error);
    throw error;
  }
}

async function getInvoiceNbrData(connections, invoice_nbr, isBigData = false) {
  try {
    let query = `SELECT * FROM  ${apDbName} where source_system = '${source_system}' and `;

    if (isBigData) {
      query += ` invoice_nbr = '${invoice_nbr}' and invoice_type = '${queryinvoiceType}' and vendor_id ='${queryVendorId}'
      order by id limit ${lineItemPerProcess + 1} offset ${queryOffset}`;
    } else {
      query += ` invoice_nbr in (${invoice_nbr.join(",")})`;
    }

    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.error("getInvoiceNbrData:error", error);
    throw "getInvoiceNbrData: No data found.";
  }
}

async function makeJsonPayload(data) {
  try {
    const singleItem = data[0];
    const hardcode = getHardcodeData();
    /**
     * head level details
     */
    const payload = {
      custbodytmsdebtorcreditorid: singleItem.bill_to_nbr ?? "",
      custbody_mfc_omni_unique_key:
        singleItem.invoice_nbr +
        "-" +
        singleItem.vendor_id +
        "-" +
        singleItem.invoice_type, //invoice_nbr, vendor_id, invoice_type
      entity: singleItem.vendor_internal_id ?? "",
      subsidiary: singleItem.subsidiary ?? "",
      trandate: singleItem.invoice_date
        ? dateFormat(singleItem.invoice_date)
        : "",
      tranid: singleItem.invoice_nbr ?? "",
      currency: singleItem.currency_internal_id ?? "",
      class: hardcode.class.head,
      department: hardcode.department.head,
      location: hardcode.location.head,
      custbody9: singleItem.file_nbr ?? "",
      custbody17: singleItem.email ?? "",
      custbody_source_system: hardcode.source_system,
      custbodymfc_tmsinvoice: singleItem.invoice_nbr ?? "",
      custbody_omni_po_hawb: singleItem.housebill_nbr ?? "",
      custbody_mode: singleItem?.mode_name ?? "",
      custbody_service_level: singleItem?.service_level ?? "",
      custbody1: hardcode.custbody1.head,
      item: data.map((e) => {
        return {
          taxcode: e.tax_code_internal_id ?? "",
          item: e.charge_cd_internal_id ?? "",
          description: e.charge_cd_desc ?? "",
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
          custcol_hawb: e.housebill_nbr ?? "",
          custcol3: e.sales_person ?? "",
          custcol5: e.master_bill_nbr ?? "",
          custcol2: {
            refName: e.controlling_stn ?? "",
          },
          custcol4: e.ref_nbr ?? "",
          custcol_riv_consol_nbr: e.consol_nbr ?? "",
          custcol_finalizedby: e.finalizedby ?? "",
          custcol_actual_weight: e.actual_weight ?? "",//dev: custcol20  prod: custcol_actual_weight
          custcol_destination_on_zip: e.dest_zip ?? "",//dev: custcol19 prod: custcol_destination_on_zip
          custcol_destination_on_state: e.dest_state ?? "",//dev: custcol18 prod: custcol_destination_on_state
          custcol_destination_on_country: e.dest_country ?? "",//dev: custcol17 prod: custcol_destination_on_country
          custcol_miles_distance: e.miles ?? "",
          custcol_chargeable_weight: e.chargeable_weight ?? "",
        };
      }),
    };

    if (singleItem.invoice_type == "IN") {
      payload.approvalstatus = "2";
    }
    if (singleItem.discount !== null) {
      payload.item.push({
        item: 4631,
        custcol_hawb: singleItem.housebill_nbr ?? "",
        amount: -singleItem.discount,
        rate: -singleItem.discount,
        department: "2",
        class: "51",
        location: {
          refName: "TL01",
        },
      });
    }

    return payload;
  } catch (error) {
    console.error("error payload", error);
    await sendDevNotification(
      source_system,
      "AP",
      "netsuite_ap_ll payload error",
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

async function createInvoice(payload, singleItem, cancelFlag = false) {
  try {
    const endpoiont =
      singleItem.invoice_type == "IN"
        ? process.env.NETSUIT_RESTLET_VB_URL
        : process.env.NETSUIT_RESTLET_VC_URL;
    const options = {
      consumer_key: userConfig.token.consumer_key,
      consumer_secret_key: userConfig.token.consumer_secret,
      token: userConfig.token.token_key,
      token_secret: userConfig.token.token_secret,
      realm: userConfig.account,
      url: endpoiont,
      method: "POST",
    };
    if (cancelFlag) {
      options.method = "PUT";
    }

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

    const response = await axios.request(configApi);
    console.log("response", response);
    if (response.status === 200 && response.data.status === "Success") {
      return response.data.id;
    } else {
      throw {
        customError: true,
        msg: response.data.reason.replace(/'/g, "`"),
        payload: JSON.stringify(payload),
        response: response.data,
      };
    }
  } catch (error) {
    if (error?.response?.reason) {
      throw {
        customError: true,
        msg: error.msg.replace(/'/g, "`"),
        payload: error.payload,
        response: JSON.stringify(error.response).replace(/'/g, "`"),
      };
    } else {
      throw {
        customError: true,
        msg: "Netsuit AP API Failed",
        response: "",
      };
    }
  }
}

/**
 * prepear the query for update interface_ap_master
 * @param {*} item
 * @param {*} invoiceId
 * @param {*} isSuccess
 * @returns
 */
function getUpdateQuery(item, invoiceId, isSuccess = true) {
  try {
    console.log("invoice_nbr ", item.invoice_nbr, invoiceId);
    let query = `UPDATE ${apDbName} `;
    if (isSuccess) {
      query += ` SET internal_id = '${invoiceId}', processed = 'P', `;
    } else {
      query += ` SET internal_id = null, processed = 'F', `;
    }
    query += ` processed_date = '${today}'  
                WHERE source_system = '${source_system}' and 
                      invoice_nbr = '${item.invoice_nbr}' and 
                      invoice_type = '${item.invoice_type}'and 
                      vendor_id = '${item.vendor_id}' and
                      system_id = '${item.system_id}'`;

    return query;
  } catch (error) {
    return "";
  }
}

/**
 * Update processed invoice ids
 * @param {*} connections
 * @param {*} query
 * @returns
 */
async function updateInvoiceId(
  connections,
  query,
  errSub = "Invoice is created But failed to update internal_id "
) {
  for (let index = 0; index < query.length; index++) {
    const element = query[index];
    console.log("element", element);
    try {
      await connections.execute(element);
    } catch (error) {
      console.log("error:updateInvoiceId", error);
      await sendDevNotification(
        source_system,
        "AP",
        "netsuite_ap_ll updateInvoiceId",
        errSub + element,
        error
      );
    }
  }
}

/**
 * hardcode data for the payload.
 * @param {*} source_system
 * @returns
 */

function getHardcodeData(isIntercompany = false) {
  const data = {
    source_system: "7",
    class: {
      head: "9",
      line: getBusinessSegment(process.env.STAGE),
    },
    department: {
      default: { head: "15", line: "2" },
      intercompany: { head: "15", line: "1" },
    },
    location: { head: "413", line: "EXT ID: Take from DB" },
    custbody1: { head: "14" },
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

//cancellation process
async function cancellationProcess() {
  try {
    let cancelledData = [];
    try {
      const query = `select distinct ae.invoice_nbr,ae.internal_id, ae.system_id, aes.status, ae.source_system from
      (select distinct invoice_nbr,internal_id,system_id,status,source_system,processed from ${apDbName} where processed='P'
      union select distinct invoice_nbr,internal_id,system_id,status,source_system,processed from ${apDbNamePrev}interface_ap_epay_his) ae
      join ${apDbNamePrev}interface_ap_epay_status aes
      on ae.invoice_nbr=aes.invoice_nbr and ae.system_id=aes.system_id
      where ae.internal_id is not null and ae.processed ='P' and ((aes.processed is null) or (aes.processed = 'F' and aes.processed_date < '${today}')) and
      aes.status ='CANCELLED' limit ${totalCountPerLoop + 1}`;
      cancelledData = await fetchCancelAndBillPaymentData(query);
      currentCount = cancelledData.length;
    } catch (error) {
      if (error == "No data found.") {
        return "billPayment";
      } else {
        throw error;
      }
    }

    const perLoop = 15;
    let queryData = [];
    for (let index = 0; index < (cancelledData.length + 1) / perLoop; index++) {
      let newArray = cancelledData.slice(
        index * perLoop,
        index * perLoop + perLoop
      );
      const data = await Promise.all(
        newArray.map(async (item) => {
          return await mainCancelProcess(item);
        })
      );
      queryData = [...queryData, ...data];
    }

    /**
     * Updating total 21 invoices at once
     */
    await updateInvoiceId(
      connections,
      queryData,
      "cancellation is successfully posted But failed to update internal_id "
    );

    if (currentCount < totalCountPerLoop) {
      return "billPayment";
    }

    return "cancellation";
  } catch (error) {
    console.error("cancellation Process: ", error);
    await sendDevNotification(
      source_system,
      "AP",
      "netsuite_ap_ll cancellation",
      "Erred out in cancellation process ",
      error
    );
    return "billPayment";
  }
}

async function fetchCancelAndBillPaymentData(query) {
  try {
    console.log("query", query, totalCountPerLoop);

    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    console.error("Error while fetching data: ", error);
    throw error;
  }
}

async function getCancelAndBillPaymentUpdateQuery(item, id, isSuccess = true) {
  try {
    console.log("item ", item);
    let query = `UPDATE ${apDbNamePrev}interface_ap_epay_status `;
    if (isSuccess) {
      query += ` SET processed = 'P', internal_id = '${id}',`;
    } else {
      query += ` SET processed = 'F',`;
    }
    query += ` processed_date = '${today}' 
                WHERE invoice_nbr = '${item.invoice_nbr}' and
                system_id = '${item.system_id}'`;

    return query;
  } catch (error) {
    return "";
  }
}

async function mainCancelProcess(item) {
  let jsonPayload = {
    id: `${item.internal_id}`,
    approvalstatus: "3",
  };
  try {
    const id = await createInvoice(jsonPayload, { invoice_type: "IN" }, true);
    console.info(
      `id = ${id} received after posting cancellation data to NS for internalid = ${item.internal_id}`
    );
    return await getCancelAndBillPaymentUpdateQuery(item, id);
  } catch (error) {
    console.error(
      "Error while posting the data to netsuite and preparing update query: ",
      error
    );
    if (error.hasOwnProperty("customError")) {
      try {
        await createAPFailedRecords(connections, item, error, apDbNamePrev);
        await sendDevNotification(
          source_system,
          "AP",
          "netsuite_ap_ll cancellation",
          "Erred out in cancellation main process ",
          error
        );
        return await getCancelAndBillPaymentUpdateQuery(item, "", false);
      } catch (error) {
        console.error("Error in mainCancelProcess: ", error);
        await sendDevNotification(
          source_system,
          "AP",
          "netsuite_ap_ll cancellation",
          "Erred out in cancellation main process ",
          error
        );
      }
    } else {
      await createAPFailedRecords(connections, item, error, apDbNamePrev);
      await sendDevNotification(
        source_system,
        "AP",
        "netsuite_ap_ll cancellation",
        "Erred out in cancellation process ",
        error
      );
      return await getCancelAndBillPaymentUpdateQuery(item, "", false);
    }
  }
}

//bill payment process
async function billPaymentProcess() {
  try {
    let billPaymentData = [];
    try {
      const query = `select ae.vendor_internal_id, ae.invoice_nbr,ae.internal_id,sum(ae.rate)-COALESCE (ae.discount,0) as rate,ae.system_id, aes.status, ae.source_system
      from (select distinct invoice_nbr,internal_id,system_id,status,source_system,processed,vendor_internal_id,rate,discount from ${apDbName} where processed='P'
        union select distinct invoice_nbr,internal_id,system_id,status,source_system,processed,vendor_internal_id,rate,discount from ${apDbNamePrev}interface_ap_epay_his) ae
      join ${apDbNamePrev}interface_ap_epay_status aes on ae.invoice_nbr=aes.invoice_nbr
        where ae.internal_id is not null and ae.processed ='P'
        and ((aes.processed is null) or (aes.processed = 'F' and aes.processed_date < '${today}')) and aes.status ='COMPLETED'
        group by ae.vendor_internal_id, ae.invoice_nbr,ae.internal_id, ae.system_id LIMIT ${totalCountPerLoop + 1}`;
      billPaymentData = await fetchCancelAndBillPaymentData(query);
      currentCount = billPaymentData.length;
    } catch (error) {
      if (error == "No data found.") {
        return "false";
      } else {
        throw error;
      }
    }

    const perLoop = 15;
    let queryData = [];
    for (
      let index = 0;
      index < (billPaymentData.length + 1) / perLoop;
      index++
    ) {
      let newArray = billPaymentData.slice(
        index * perLoop,
        index * perLoop + perLoop
      );
      const data = await Promise.all(
        newArray.map(async (item) => {
          return await mainBillPaymentProcess(item);
        })
      );
      queryData = [...queryData, ...data];
    }

    /**
     * Updating total 21 invoices at once
     */
    await updateInvoiceId(
      connections,
      queryData,
      "bill payment is successfully posted But failed to update internal_id "
    );

    if (currentCount < totalCountPerLoop) {
      return "false";
    }

    return "true";
  } catch (error) {
    console.error("cancellation Process: ", error);
    await sendDevNotification(
      source_system,
      "AP",
      "netsuite_ap_ll billPayment",
      "Erred out in bill payment process ",
      error
    );
    return "false";
  }
}

async function mainBillPaymentProcess(item) {
  const hardcode = getHardcodeData();
  let jsonPayload = {
    custbody_mfc_omni_unique_key: `${item.vendor_internal_id}-3490-${item.internal_id}`,
    entity: item.vendor_internal_id,
    subsidiary: 65,
    account: 3490,
    department: hardcode.department.head,
    class: hardcode.class.head,
    location: hardcode.location.head,
    tranid: item.system_id,
    custbody1: "14",
    apply: [
      {
        internalid: item.internal_id,
        apply: true,
        amount: item.rate,
      },
    ],
  };
  if(['MILLFLNC','TRINMEWI','TRINHOTX','TRINLENC','TRINMIFL'].includes(item.vendor_id)){
    jsonPayload.apacct = 296
  }else{
    jsonPayload.apacct = 295
  }
  jsonPayload.custbody_9997_is_for_ep_eft = false
  try {
    const id = await sendBillpaymentData(jsonPayload);
    return await getCancelAndBillPaymentUpdateQuery(item, id);
  } catch (error) {
    console.error(
      "Error while posting the data to netsuite and preparing update query: ",
      error
    );
    if (error.hasOwnProperty("customError")) {
      try {
        await createAPFailedRecords(connections, item, error, apDbNamePrev);
        await sendDevNotification(
          source_system,
          "AP",
          "netsuite_ap_ll billPayment",
          "Erred out in bill payment process ",
          error
        );
        return await getCancelAndBillPaymentUpdateQuery(item, "", false);
      } catch (error) {
        console.error("Error in mainCancelProcess: ", error);
        await sendDevNotification(
          source_system,
          "AP",
          "netsuite_ap_ll billPayment",
          "Erred out in bill payment main process ",
          error
        );
      }
    } else {
      await createAPFailedRecords(connections, item, error, apDbNamePrev);
      await sendDevNotification(
        source_system,
        "AP",
        "netsuite_ap_ll billPayment",
        "Erred out in bill payment main process ",
        error
      );
      return await getCancelAndBillPaymentUpdateQuery(item, "", false);
    }
  }
}

async function sendBillpaymentData(payload) {
  try {
    const endpoiont = process.env.NS_BILL_PAYMENT_URL;
    const options = {
      consumer_key: userConfig.token.consumer_key,
      consumer_secret_key: userConfig.token.consumer_secret,
      token: userConfig.token.token_key,
      token_secret: userConfig.token.token_secret,
      realm: userConfig.account,
      url: endpoiont,
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

    const response = await axios.request(configApi);
    console.log("response", response);
    if (response.status === 200 && response.data.status === "Success") {
      return response.data.id;
    } else {
      throw {
        customError: true,
        msg: response.data.reason.replace(/'/g, "`"),
        payload: JSON.stringify(payload),
        response: response.data,
      };
    }
  } catch (error) {
    if (error?.response?.reason) {
      throw {
        customError: true,
        msg: error.msg.replace(/'/g, "`"),
        payload: error.payload,
        response: JSON.stringify(error.response).replace(/'/g, "`"),
      };
    } else {
      throw {
        customError: true,
        msg: "Netsuit AP API Failed",
        response: "",
      };
    }
  }
}
