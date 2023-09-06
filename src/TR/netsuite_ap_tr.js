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
const apDbName = apDbNamePrev + "interface_ap";
const source_system = "TR";

const today = getCustomDate();
const lineItemPerProcess = 500;
let totalCountPerLoop = 20;
let queryOffset = 0;
let queryinvoiceType = "IN"; // IN / CM
let queryOperator = "<=";
let queryInvoiceId = null;
let queryInvoiceNbr = null;
let queryVendorId = null;

module.exports.handler = async (event, context, callback) => {
  userConfig = getConfig(source_system, process.env);

  console.info("event", event);
  let currentCount = 0;
  totalCountPerLoop = event.hasOwnProperty("totalCountPerLoop")
    ? event.totalCountPerLoop
    : 21;
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

  try {
    /**
     * Get connections
     */
    connections = await getConnectionToRds(process.env);

    /**
     * will work on this if section if rest can't handle more than 500 line items.
     */
    if (queryOperator == ">") {
      // Update 500 line items per process
      console.info("> start");

      totalCountPerLoop = 0;
      if (queryInvoiceId != null && queryInvoiceId.toString().length > 0) {
        console.info(">if");

        try {
          const invoiceDataList = await getInvoiceNbrData(
            connections,
            queryInvoiceNbr,
            true
          );

          try {
            await createInvoiceAndUpdateLineItems(
              queryInvoiceId,
              invoiceDataList
            );
          } catch (error) {
            console.info("work later");
          }

          if (lineItemPerProcess >= invoiceDataList.length) {
            throw "Next Process";
          } else {
            return {
              hasMoreData: "true",
              queryOperator,
              queryOffset: queryOffset + lineItemPerProcess + 1,
              queryInvoiceId,
              queryInvoiceNbr,
              queryinvoiceType,
              queryVendorId,
            };
          }
        } catch (error) {
          return {
            hasMoreData: "true",
            queryOperator,
          };
        }
      } else {
        console.info("> else");

        try {
          let invoiceDataList = [];
          let orderData = [];
          try {
            orderData = await getDataGroupBy(connections);
            console.info("orderData", orderData.length);
          } catch (error) {
            await triggerReportLambda(
              process.env.NS_RESTLET_INVOICE_REPORT,
              "TR_AP"
            );
            await startNextStep();
            return { hasMoreData: "false" };
          }
          queryInvoiceNbr = orderData[0].invoice_nbr;
          queryVendorId = orderData[0].vendor_id;
          queryinvoiceType = orderData[0].invoice_type;

          invoiceDataList = await getInvoiceNbrData(
            connections,
            queryInvoiceNbr,
            true
          );
          console.info("invoiceDataList", invoiceDataList.length);
          /**
           * set queryInvoiceId in this process and return update query
           */
          const queryData = await mainProcess(orderData[0], invoiceDataList);
          await updateInvoiceId(connections, [queryData]);

          /**
           * if items <= 501 process next invoice
           * or send data for next update process of same invoice.
           */
          if (
            invoiceDataList.length <= lineItemPerProcess ||
            queryInvoiceId == null
          ) {
            console.info("next invoice");
            throw "Next Invoice";
          } else {
            console.info("next exec", {
              hasMoreData: "true",
              queryOperator,
              queryOffset: queryOffset + lineItemPerProcess + 1,
              queryInvoiceId,
              queryInvoiceNbr: queryInvoiceNbr,
              queryinvoiceType: orderData[0].invoice_type,
              queryVendorId,
            });

            return {
              hasMoreData: "true",
              queryOperator,
              queryOffset: queryOffset + lineItemPerProcess + 1,
              queryInvoiceId,
              queryInvoiceNbr: queryInvoiceNbr,
              queryinvoiceType: orderData[0].invoice_type,
              queryVendorId,
            };
          }
        } catch (error) {
          console.info("error", error);
          return {
            hasMoreData: "true",
            queryOperator,
          };
        }
      }
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
        return {
          hasMoreData: "true",
          queryOperator: queryOperator == "<=" ? ">" : "<=",
        };
      }

      try {
        invoiceIDs = orderData.map((a) => "'" + a.invoice_nbr + "'");
        console.info("orderData**", orderData.length, orderData);
        console.info("invoiceIDs", invoiceIDs);
        if (orderData.length === 1) {
          console.info("length==1", orderData);
        }
        currentCount = orderData.length;
        invoiceDataList = await getInvoiceNbrData(connections, invoiceIDs);
        console.info("invoiceDataList", invoiceDataList.length);
      } catch (error) {
        console.error("error:getInvoiceNbrData:try:catch", error);
        console.error(
          "invoiceIDs:try:catch found on getDataGroupBy but not in getInvoiceNbrData",
          invoiceIDs
        );
        return {
          hasMoreData: "true",
          queryOperator,
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
        queryOperator = ">";
      }
      return { hasMoreData: "true", queryOperator };
    }
  } catch (error) {
    console.error("error", error);
    await triggerReportLambda(process.env.NS_RESTLET_INVOICE_REPORT, "TR_AP");
    await startNextStep();
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
        e.gc_code == item.gc_code
      );
    });

    /**
     * set single item and customer data
     */
    singleItem = dataList[0];

    /**
     * Make Json payload
     */
    const jsonPayload = await makeJsonPayload(dataList);
    /**
     * create invoice
     */
    const invoiceId = await createInvoice(jsonPayload, singleItem);
    console.info("invoiceId",invoiceId);

    if (queryOperator == ">") {
      queryInvoiceId = invoiceId.toString();
    }

    /**
     * update invoice id
     */
    const getQuery = getUpdateQuery(singleItem, invoiceId);
    return getQuery;
  } catch (error) {
    console.error("mainprocess:error",error);
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

    const dateCheckOperator = "<";
    const query = `SELECT invoice_nbr, vendor_id, invoice_type, count(*) as tc,gc_code
    FROM dw_uat.interface_ap 
    WHERE  ((internal_id is null and processed is null and vendor_internal_id is not null) or
    (vendor_internal_id is not null and processed ='F' and processed_date ${dateCheckOperator} '${today}')) and 
    ((intercompany='Y' and pairing_available_flag ='Y') OR 
      intercompany='N'
    )
    and source_system = '${source_system}' and invoice_nbr != '' and gc_code is not null 
    GROUP BY invoice_nbr, vendor_id, invoice_type,gc_code 
    having tc ${queryOperator} ${lineItemPerProcess} 
    limit ${totalCountPerLoop + 1}`;

    console.info("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    throw "No data found.";
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
    console.error("error1", error);
    throw "getInvoiceNbrData: No data found.";
  }
}

async function makeJsonPayload(data) {
  try {
    const singleItem = data[0];
    const hardcode = getHardcodeData(
      singleItem?.intercompany == "Y" ? true : false
    );
    /**
     * head level details
     */
    const payload = {
      custbody_mfc_omni_unique_key:
      singleItem.invoice_nbr +
      "-" +
      singleItem.vendor_id +
      "-" +
      singleItem.invoice_type+
      "-"+
      singleItem.gc_code, //invoice_nbr, vendor_id, invoice_type,gc_code
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
      otherRefNum: singleItem.customer_po ?? "",
      custbody9: singleItem.file_nbr ?? "",//1730
      custbody17: singleItem.email ?? "",//1744
      custbody_source_system: hardcode.source_system,//2327
      custbody_omni_po_hawb: singleItem.housebill_nbr ?? "",//1748  //need to check on 1756 internal id with priyanka
      custbody_mode: singleItem?.mode_name ?? "",//2673
      custbody_service_level: singleItem?.service_level ?? "",//2674
      memo:singleItem.housebill_nbr ?? "",
      
      item: data.map((e) => {
        return {
          // custcol_mfc_line_unique_key:"",
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
          custcol_hawb: e.housebill_nbr ?? "",//760
          custcol3: e.sales_person ?? "",//1167
          custcol5: e.master_bill_nbr ?? "",//1727
          custcol2: {
            refName: e.controlling_stn ?? "",//1166
          },
          custcol4: e.ref_nbr ?? "",//1168
          custcol_riv_consol_nbr: e.consol_nbr ?? "",////prod:- 2510 dev:- 2506
          custcol_finalizedby: e.finalizedby ?? "",//2614
        };
      }),
    };
    if (singleItem.invoice_type == "IN") {
      payload.approvalstatus = "2";
    }

    return payload;
  } catch (error) {
    console.error("error payload", error);
    await sendDevNotification(
      source_system,
      "AP",
      "netsuite_ap_tr payload error",
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
          ? process.env.NETSUIT_RESTLET_VB_URL
          : process.env.NETSUIT_RESTLET_VC_URL;

    const options = {
      consumer_key: userConfig.token.consumer_key,
      consumer_secret_key: userConfig.token.consumer_secret,
      token: userConfig.token.token_key,
      token_secret: userConfig.token.token_secret,
      realm: userConfig.account,
      url: endpoiont,
      method: 'POST',
    };

    const authHeader =  getAuthorizationHeader(options);

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
        msg: 'Netsuit AP API Failed',
        response: '',
      };
    }
  }
}


async function makeLineItemsJsonPayload(invoiceId, data) {
  try {
    const hardcode = getHardcodeData();

    /**
     * head level details
     */
    const payload = {
      id: invoiceId,
      item: data.map((e) => {
        return {
          // custcol_mfc_line_unique_key:"",
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
        };
      }),
    };
    return payload;
  } catch (error) {
    console.error("error payload", error);
    await sendDevNotification(
      source_system,
      "AP",
      "netsuite_ap_tr payload error",
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



async function createInvoiceAndUpdateLineItems(invoiceId, data) {
  try {
    const endpoint =
      data[0].invoice_type == 'IN'
        ? process.env.NETSUIT_RESTLET_VB_URL
        : process.env.NETSUIT_RESTLET_VC_URL;

    const options = {
      consumer_key: userConfig.token.consumer_key,
      consumer_secret_key: userConfig.token.consumer_secret,
      token: userConfig.token.token_key,
      token_secret: userConfig.token.token_secret,
      realm: userConfig.account,
      url: endpoint,
      method: 'PUT',
    };

    const authHeader =  getAuthorizationHeader(options);

    const payload = makeLineItemsJsonPayload(invoiceId, data);
    console.info('payload', JSON.stringify(payload));

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
    console.log('error:createInvoice:main:catch', error);
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
        msg: 'Netsuit AP API Failed',
        response: '',
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
    console.info("invoice_nbr ", item.invoice_nbr, invoiceId);
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
                      vendor_id = '${item.vendor_id}'`;

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
async function updateInvoiceId(connections, query) {
  for (let index = 0; index < query.length; index++) {
    const element = query[index];
    try {
      await connections.execute(element);
    } catch (error) {
      console.error("error:updateInvoiceId", error);
      await sendDevNotification(
        source_system,
        "AP",
        "netsuite_ap_tr updateInvoiceId",
        "Invoice is created But failed to update internal_id " + element,
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
    source_system: "1",
    class: {
      head: "9",
      line: getBusinessSegment(process.env.STAGE),
    },
    department: {
      default: { head: "15", line: "2" },
      intercompany: { head: "16", line: "2" },
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
      stateMachineArn: process.env.NETSUITE_INTERCOMPANY_STEP_ARN,
      input: JSON.stringify({}),
    };
    const stepfunctions = new AWS.StepFunctions();
    const data = await new Promise((resolve, reject) => {
      stepfunctions.startExecution(params, (err, data) => {
        if (err) {
          console.error("Netsuit NETSUITE_INTERCOMPANY_STEP_ARN trigger failed");
          reject(err);
        } else {
          console.info("Netsuit NETSUITE_INTERCOMPANY_STEP_ARN started");
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