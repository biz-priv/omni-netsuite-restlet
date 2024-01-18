const AWS = require("aws-sdk");
const {SNS_TOPIC_ARN } = process.env;
const sns = new AWS.SNS({ region: process.env.REGION });
const axios = require("axios");
const {
  getConfig,
  getConnectionToRds,
  getAuthorizationHeader,
  createAPFailedRecords,
  sendDevNotification,
} = require("../../Helpers/helper");
const moment = require("moment");

let userConfig = "";

let totalCountPerLoop = 5;
const today = getCustomDate();
const apDbNamePrev = process.env.DATABASE_NAME;
const apDbName = apDbNamePrev + "interface_ap";
const source_system = "TR";

module.exports.handler = async (event, context, callback) => {
  userConfig = getConfig(source_system, process.env);
  const checkIsRunning = await checkOldProcessIsRunning();
  if (checkIsRunning) {
    return {
      hasMoreData: "false",
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
     * Get data from db
     */
    const vendorList = await getVendorData(connections);
    console.info("vendorList", vendorList);
    currentCount = vendorList.length;

    for (let i = 0; i < vendorList.length; i++) {
      const vendor_id = vendorList[i].vendor_id;
      console.info("vendor_id", vendor_id);
      try {
        /**
         * get vendor from netsuit
         */
        const vendorData = await getVendor(vendor_id);
        console.info("vendorData", vendorData);

        /**
         * Update vendor details into DB
         */
       
        await putVendor(connections, vendorData, vendor_id);
        console.info("count", i + 1);
      } catch (error) {
        let singleItem = "";
        try {
          if (error.hasOwnProperty("customError")) {
            /**
             * update error
             */
            singleItem = await getDataByVendorId(connections, vendor_id);
            await updateFailedRecords(connections, vendor_id);
            await createAPFailedRecords(
              connections,
              singleItem,
              error,
              apDbNamePrev
            );
          }
        } catch (error) {
          console.error("err", error);
          await sendDevNotification(
            source_system,
            "AP",
            "netsuite_vendor_ap_tr for loop vendor id =" + vendor_id,
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
    const params = {
			Message: `Error in ${context.functionName}, Error: ${error.message}`,
			TopicArn: SNS_TOPIC_ARN,
		};
    await sns.publish(params).promise();
    hasMoreData = "false";
  }

  if (hasMoreData == "false") {
    return { hasMoreData };
  } else {
    return { hasMoreData };
  }
};

async function getVendorData(connections) {
  try {
    const query =`SELECT distinct vendor_id FROM  ${apDbName}
                    where ((vendor_internal_id is NULL  and processed_date is null) or
                            (vendor_internal_id is null and processed_date < '${today}'))
                          and source_system = '${source_system}' order by vendor_id 
                          limit ${totalCountPerLoop + 1}`;
    console.info("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found";
    }
    return result;
  } catch (error) {
    console.error(error, "error");
    throw "getVendorData: No data found.";
  }
}

async function getDataByVendorId(connections, vendor_id) {
  try {
    const query = `select * from ${apDbName} 
                    where source_system = '${source_system}' and vendor_id = '${vendor_id}' 
                    limit 1`;
    console.info("query", query);
    const [rows] = await connections.execute(query);
    const result = rows;
    if (!result || result.length == 0) {
      throw "No data found.";
    }
    return result[0];
  } catch (error) {
    throw "getDataByVendorId: No data found.";
  }
}

async function getVendor(entityId) {
  try {
    const options = {
      consumer_key: userConfig.token.consumer_key,
      consumer_secret_key: userConfig.token.consumer_secret,
      token: userConfig.token.token_key,
      token_secret: userConfig.token.token_secret,
      realm: userConfig.account,
      url: `${process.env.NS_BASE_URL}&deploy=2&custscript_mfc_entity_eid=${entityId}`,
      method: "GET",
    };
    const authHeader =  getAuthorizationHeader(options);

    const configApi = {
      method: options.method,
      maxBodyLength: Infinity,
      url: options.url,
      headers: {
        ...authHeader,
      },
    };
    const response =  await axios.request(configApi);
    console.info("response", response.status);
    const recordList = response.data[0];
    if (recordList && recordList.internalid_value) {
      const record = recordList;
      return record;
    } else {
      throw {
        customError: true,
        msg: `Vendor not found. (vendor_id: ${entityId})`,
        response: response
      };
    }
  } catch (err) {
    console.error("error", err);
    if (err.response.status == 200) {
      throw {
        customError: true,
        msg: `Vendor not found. (vendor_id: ${entityId})`,
      };
    } else {
      throw {
        customError: true,
        msg: "Vendor API Failed",
      };
    }
  }
}

async function putVendor(connections, vendorData, vendor_id) {
  try {
    const vendor_internal_id = vendorData.internalid_value;
    console.info("vendor_internal_id", vendor_internal_id);


    // const formatData = {
    //   vendor_internal_id: vendorData?.internalid ?? "",
    //   vendor_id: vendorData?.entityid ?? "",
    //   externalId: vendorData?.externalid,
    //   balance: vendorData?.balance,
    //   // balancePrimary: vendorData?.balancePrimary,
    //   companyName: vendorData?.companyname,
    //   // currency_internal_id: vendorData?.currency.id,
    //   curr_cd: vendorData?.currency,
    //   // currency_id: vendorData?.currency.id,
    //   currency_refName: vendorData?.currency,
    //   custentity_1099_misc: vendorData?.custentity_1099_misc,
    //   custentity_11724_pay_bank_fees:
    //     vendorData?.custentity_11724_pay_bank_fees,
    //   custentity_2663_payment_method:
    //     vendorData?.custentity_2663_payment_method,
    //   // custentity_riv_external_id: vendorData?.custentity_riv_external_id,
    //   dateCreated: vendorData?.datecreated,
    //   defaultAddress: vendorData?.address,
    //   emailTransactions: vendorData?.emailtransactions,
    //   faxTransactions: vendorData?.faxtransactions,
    //   // isAutogeneratedRepresentingEntity:
    //   //   vendorData?.isAutogeneratedRepresentingEntity,
    //   isInactive: vendorData?.isinactive,
    //   isJobResourceVend: vendorData?.isjobresourcevend,
    //   isPerson: vendorData?.isperson,
    //   lastModifiedDate: vendorData?.lastmodifieddate,
    //   legalName: vendorData?.legalname,
    //   phone: vendorData?.phone,
    //   printTransactions: vendorData?.printtransactions,
    //   // subsidiaryEdition: vendorData?.subsidiaryEdition,
    //   unbilledOrders: vendorData?.unbilledorders,
    //   // unbilledOrdersPrimary: vendorData?.unbilledOrdersPrimary,

    //   // customForm_id: vendorData?.customForm.id,
    //   // customForm_refName: vendorData?.customForm.refName,
    //   // emailPreference_id: vendorData?.emailPreference.id,
    //   emailPreference_refName: vendorData?.emailpreference,
    //   // subsidiary_id: vendorData?.subsidiary.id,
    //   subsidiary_refName: vendorData?.subsidiary,

    //   created_at: moment().format("YYYY-MM-DD"),
    // };
    const formatData = {
      vendor_internal_id: vendorData?.internalid_value ?? "",
      vendor_id: vendorData?.entityid_value ?? "",
      externalId: vendorData?.externalId_value,
      balancePrimary: vendorData?.balancePrimary_value,
      companyName:
        vendorData?.companyName_value.length > 0
          ? vendorData?.companyName_value?.replace(/'/g, "`")
          : "",
      currency_internal_id: vendorData?.currency_internal_id_value,
      curr_cd: vendorData?.currency_internal_id_text,
      currency_id: vendorData?.currency_internal_id_value,
      currency_refName: vendorData?.currency_internal_id_text,
      custentity_1099_misc: vendorData?.custentity_1099_misc_value,
      custentity_11724_pay_bank_fees:
        vendorData?.custentity_11724_pay_bank_fees_value,
      custentity_2663_payment_method:
        vendorData?.custentity_2663_payment_method_value,
      dateCreated: vendorData?.dateCreated_value,
      defaultAddress:
        vendorData?.defaultAddress_value.length > 0
          ? vendorData?.defaultAddress_value?.replace(/'/g, "`")
          : "",
      emailTransactions: vendorData?.emailTransactions_value,
      faxTransactions: vendorData?.faxTransactions_value,
      isInactive: vendorData?.isInactive_value,
      isJobResourceVend: vendorData?.isJobResourceVend_value,
      isPerson: vendorData?.isPerson_value,
      lastModifiedDate: vendorData?.lastModifiedDate_value,
      legalName: vendorData?.legalName_value?.replace(/'/g, "`"),
      phone: vendorData?.phone_value,
      printTransactions: vendorData?.printTransactions_value,
      unbilledOrders: vendorData?.unbilledOrdersPrimary_value,
      emailPreference_id: vendorData?.emailPreference_id_value,
      emailPreference_refName: vendorData?.emailPreference_id_text,
      subsidiary_id: vendorData?.subsidiary_id_value,
      subsidiary_refName: vendorData?.subsidiary_id_text,
      created_at: moment().format("YYYY-MM-DD"),
    };

    let tableStr = "";
    let valueStr = "";
    let updateStr = "";

    let objKyes = Object.keys(formatData);
    objKyes.map((e, i) => {
      if (i > 0) {
        valueStr += ",";
        updateStr += e != "vendor_id" ? "," : "";
      }
      if (e != "vendor_id") {
        updateStr += e + "='" + formatData[e] + "'";
      }
      valueStr += "'" + formatData[e] + "'";
    });
    tableStr = objKyes.join(",");
    const upsertQuery = `INSERT INTO ${apDbNamePrev}netsuit_vendors (${tableStr})
                        VALUES (${valueStr}) ON DUPLICATE KEY
                        UPDATE ${updateStr};`;
    console.info("query", upsertQuery);
    await connections.execute(upsertQuery);

    const updateQuery = `UPDATE  ${apDbName} SET
                    processed = null,
                    vendor_internal_id = '${vendor_internal_id}', 
                    processed_date = '${today}' 
                    WHERE vendor_id = '${vendor_id}' and source_system = '${source_system}' and vendor_internal_id is null;`;
    console.info("updateQuery", updateQuery);
    await connections.execute(updateQuery);
  } catch (error) {
    console.error(error);
    throw "Vendor Update Failed";
  }
}

async function updateFailedRecords(connections, vendor_id) {
  try {
    let query = `UPDATE ${apDbName} SET 
                  processed = 'F',
                  processed_date = '${today}' 
                  WHERE vendor_id = '${vendor_id}' and source_system = '${source_system}' and vendor_internal_id is null`;
    const result = await connections.query(query);
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



// async function checkOldProcessIsRunning() {
//   try {
//     //tr ar 
//     const customerArn = process.env.NETSUITE_AP_TR_VENDOR_STEP_ARN;


//     const status = "RUNNING";
//     const stepfunctions = new AWS.StepFunctions();

//     const getExecutionList = async (stateMachineArn) => {
//       return new Promise((resolve, reject) => {
//         stepfunctions.listExecutions(
//           {
//             stateMachineArn,
//             statusFilter: status,
//             maxResults: 2,
//           },
//           (err, data) => {
//             if (err) {
//               reject(err);
//             } else {
//               resolve(data.executions);
//             }
//           }
//         );
//       });
//     };

//     const customerExcList = await getExecutionList(customerArn);
//     if (customerExcList.length === 2 && customerExcList[1].status === status) {
//       console.log("AP running");
//       return true;
//     }

//     return false;
//   } catch (error) {
//     return true;
//   }
// }


async function checkOldProcessIsRunning() {
  try {
    const vendorArn = process.env.NETSUITE_AP_TR_VENDOR_STEP_ARN;
    const status = "RUNNING";
    const stepfunctions = new AWS.StepFunctions();

    const data = await stepfunctions.listExecutions({
      stateMachineArn: vendorArn,
      statusFilter: status,
      maxResults: 2,
    }).promise();

    console.info("AP listExecutions data", data);
    const venExcList = data.executions;

    if (
      data &&
      venExcList.length === 2 &&
      venExcList[1].status === status
    ) {
      console.info("AP running");
      return true;
    } else {
      return false;
    }
  } catch (error) {
    return true;
  }
}