const AWS = require("aws-sdk");
const axios = require("axios");
const {
  getConfig,
  getConnectionToRds,
  getAuthorizationHeader,
  createARFailedRecords,
  sendDevNotification,
} = require("../../Helpers/helper");
const moment = require("moment");

let userConfig = "";

let totalCountPerLoop = 5;
const today = getCustomDate();

const arDbNamePrev = process.env.DATABASE_NAME;
const arDbName = arDbNamePrev + "interface_ar";
const source_system = "LL";

module.exports.handler = async (event, context, callback) => {
  userConfig = getConfig(source_system, process.env);
  const checkIsRunning = await checkOldProcessIsRunning();
  if (checkIsRunning) {
    return {
      hasMoreData: "running",
    };
  }
  let hasMoreData = "false";
  let currentCount = 0;
  totalCountPerLoop = event.hasOwnProperty("totalCountPerLoop")
    ? event.totalCountPerLoop
    : totalCountPerLoop;
  try {
    /**
     * Get connections
     */
    const connections = await getConnectionToRds(process.env);

    /**
     * Get data from  db
     */
    const customerList = await getCustomerData(connections);
    console.info("customerList", customerList);

    currentCount = customerList.length;

    for (let i = 0; i < customerList.length; i++) {
      const customer_id = customerList[i].customer_id;
      console.info("customer_id", customer_id);
      try {
        /**
         * get customer from netsuit
         */
        const customerData = await getcustomer(customer_id);
        console.info("customerData", JSON.stringify(customerData));
        /**
         * Update customer details into DB
         */

        await putCustomer(connections, customerData, customer_id);
        console.info("count", i + 1);
      } catch (error) {
        let singleItem = "";
        try {
          if (error.hasOwnProperty("customError")) {
            /**
             * update error
             */
            singleItem = await getDataByCustomerId(connections, customer_id);
            await updateFailedRecords(connections, customer_id);
            await createARFailedRecords(
              connections,
              singleItem,
              error,
              arDbNamePrev
            );
          }
        } catch (error) {
          console.error("err", error);
          await sendDevNotification(
            source_system,
            "AR",
            "netsuite_customer_ar_ll for loop customer_id" + customer_id,
            singleItem,
            error
          );
        }
      }
    }

    if (currentCount > totalCountPerLoop) {
      hasMoreData = "true";
    } else {
      hasMoreData = "false";
    }
  } catch (error) {
    hasMoreData = "false";
  }

  if (hasMoreData == "false") {
    return { hasMoreData };
  } else {
    return { hasMoreData };
  }
};

async function getCustomerData(connections) {
  try {

    const query = `SELECT distinct customer_id FROM ${arDbName} 
                    where customer_internal_id is null and ( processed_date is null or
                           processed_date < '${today}')
                          and source_system = '${source_system}'
                          limit ${totalCountPerLoop + 1}`;

    console.info("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result;
  } catch (error) {
    throw "getCustomerData: No data found.";
  }
}

async function getDataByCustomerId(connections, cus_id) {
  try {
    const query = `SELECT * FROM ${arDbName} 
                    where source_system = '${source_system}' and customer_id = '${cus_id}' 
                    limit 1`;
    console.info("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result[0];
  } catch (error) {
    throw "getDataByCustomerId: No data found.";
  }
}


async function getcustomer(entityId) {
  try {
    const options = {
      consumer_key: userConfig.token.consumer_key,
      consumer_secret_key: userConfig.token.consumer_secret,
      token: userConfig.token.token_key,
      token_secret: userConfig.token.token_secret,
      realm: userConfig.account,
      url: `${process.env.NS_BASE_URL}&deploy=1&custscript_mfc_entity_eid=${entityId}`,
      method: "GET",
    };
    const authHeader = getAuthorizationHeader(options);

    const configApi = {
      method: options.method,
      maxBodyLength: Infinity,
      url: options.url,
      headers: {
        ...authHeader,
      },
    };

    const response = await axios.request(configApi);
    console.info("response", response.status);

    const recordList = response.data[0];
    if (recordList && recordList.internal_id_value) {
      const record = recordList;
      return record;
    } else {
      throw {
        customError: true,
        msg: `Customer not found. (customer_id: ${entityId})`,
        response: response
      };
    }
  } catch (err) {
    console.error("error", err);
    if (err.response.status == 200) {
      throw {
        customError: true,
        msg: `Customer not found. (customer_id: ${entityId})`,
      };
    } else {
      throw {
        customError: true,
        msg: "Customer API Failed",
      };
    }
  }
}

async function putCustomer(connections, customerData, customer_id) {
  try {
    const customer_internal_id = customerData.internal_id_value;

    const formatData = {
      customer_internal_id: customerData?.internal_id_value ?? "",
      customer_id: customerData?.entityId_value ?? "",
      currency_internal_id: customerData?.currency_internal_id_value,
      curr_cd: customerData?.currency_internal_id_text,
      currency_id: customerData?.currency_internal_id_value,
      currency_refName: customerData?.currency_internal_id_text,
      custentity5: customerData?.custentity5_value ?? "",
      custentity_2663_customer_refund:
        customerData?.custentity_2663_customer_refund_value ?? "",
      custentity_2663_direct_debit:
        customerData?.custentity_2663_direct_debit_value ?? "",
      custentity_ee_account_no: customerData?.custentity_ee_account_no_value ?? "",
      custentity_riv_assigned_collector:
        customerData?.custentity_riv_assigned_collector_value ?? "",
      dateCreated: customerData?.dateCreated_value ?? "",
      daysOverdue: customerData?.daysOverdue_value ?? "",
      defaultAddress:
        customerData?.defaultAddress_value.length > 0
          ? customerData?.defaultAddress_value?.replace(/'/g, "`")
          : "",
      depositBalance: customerData?.depositBalance_value ?? "",
      balance: customerData?.balance_value ?? "",
      companyName:
        customerData?.companyName_value.length > 0
          ? customerData?.companyName_value?.replace(/'/g, "`")
          : "",
      emailTransactions: customerData?.emailTransactions_value ?? "",
      faxTransactions: customerData?.faxTransactions_value ?? "",
      isInactive: customerData?.isInactive_value ?? "",
      lastModifiedDate: customerData?.lastModifiedDate_value ?? "",
      overdueBalance: customerData?.overdueBalance_value ?? "",
      printTransactions: customerData?.printTransactions_value ?? "",
      unbilledOrders: customerData?.unbilledOrders_value ?? "",
      shipComplete: customerData?.shipComplete_value ?? "",

      creditHoldOverride_id: customerData?.creditHoldOverride_id_value,
      creditHoldOverride_refName: customerData?.creditHoldOverride_id_text,
      emailPreference_id: customerData?.emailPreference_id_value,
      emailPreference_refName: customerData?.emailPreference_id_text,
      entityStatus_id: customerData?.entityStatus_id_value,
      entityStatus_refName: customerData?.entityStatus_id_text,
      receivablesAccount_refName: customerData?.receivablesAccount_id_value,
      shippingCarrier_id: customerData?.shippingCarrier_id_value,
      shippingCarrier_refName: customerData?.shippingCarrier_id_text,
      subsidiary_id: customerData?.subsidiary_id_value,
      subsidiary_refName: customerData?.subsidiary_id_text,
      terms_id: customerData?.terms_id_value,
      terms_refName: customerData?.terms_id_text,
      created_at: moment().format("YYYY-MM-DD"),
    };


    let tableStr = "";
    let valueStr = "";
    let updateStr = "";

    let objKyes = Object.keys(formatData);
    objKyes.map((e, i) => {
      if (i > 0) {
        valueStr += ",";
        updateStr += e != "customer_id" ? "," : "";
      }
      if (e != "customer_id") {
        updateStr += e + "='" + formatData[e] + "'";
      }
      valueStr += "'" + formatData[e] + "'";
    });
    tableStr = objKyes.join(",");

    const upsertQuery = `INSERT INTO ${arDbNamePrev}netsuit_customer_tharun_backup (${tableStr})
                        VALUES (${valueStr}) ON DUPLICATE KEY
                        UPDATE ${updateStr};`;
    console.info("query", upsertQuery);
    await connections.execute(upsertQuery);

    const updateQuery = `UPDATE ${arDbName} SET 
                    processed = null, 
                    customer_internal_id = '${customer_internal_id}', 
                    processed_date = '${today}' 
                    WHERE customer_id = '${customer_id}' and source_system = '${source_system}' and customer_internal_id is null`;
    console.info("updateQuery", updateQuery);
    await connections.execute(updateQuery);
  } catch (error) {
    console.error(error);
    throw "Customer Update Failed";
  }
}

async function updateFailedRecords(connections, cus_id) {
  try {
    let query = `UPDATE ${arDbName}  
                  SET processed = 'F',
                  processed_date = '${today}' 
                  WHERE customer_id = '${cus_id}' and source_system = '${source_system}' and customer_internal_id is null`;
    console.info("query", query);
    const result = await connections.execute(query);
    return result;
  } catch (error) { }
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
    const customerArn = process.env.NETSUITE_AR_LL_CUSTOMER_STEP_ARN;
    const status = "RUNNING";
    const stepfunctions = new AWS.StepFunctions();

    const data = await stepfunctions.listExecutions({
      stateMachineArn: customerArn,
      statusFilter: status,
      maxResults: 2,
    }).promise();

    console.info("AR listExecutions data", data);
    const cusExcList = data.executions;

    if (
      data &&
      cusExcList.length === 2 &&
      cusExcList[1].status === status
    ) {
      console.info("AR running");
      return true;
    } else {
      return false;
    }
  } catch (error) {
    return true;
  }
}