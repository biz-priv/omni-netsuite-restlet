const AWS = require("aws-sdk");
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
const source_system = "CW";

module.exports.handler = async (event, context, callback) => {
  userConfig = getConfig(source_system, process.env);
  // const checkIsRunning = await checkOldProcessIsRunning();
  // if (checkIsRunning) {
  //   return {
  //     hasMoreData: "false",
  //   };
  // }
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
        console.log("vendorData", vendorData);
       
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
          await sendDevNotification(
            source_system,
            "AP",
            "netsuite_vendor_ap_cw for loop vendor id =" + vendor_id,
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

// function getVendor(entityId) {
//   return new Promise((resolve, reject) => {
//     const NsApi = new NsApiWrapper({
//       consumer_key: userConfig.token.consumer_key,
//       consumer_secret_key: userConfig.token.consumer_secret,
//       token: userConfig.token.token_key,
//       token_secret: userConfig.token.token_secret,
//       realm: userConfig.account,
//     });
    
//     NsApi.request({
//       path: `record/v1/vendor/eid:${entityId}`,
//     })
//       .then((response) => {
//         const recordList = response.data;
//         if (recordList && recordList.id) {
//           const record = recordList;
//           resolve(record);
//         } else {
//           reject({
//             customError: true,
//             msg: `Vendor not found. (vendor_id: ${entityId})`,
//           });
//         }
//       })
//       .catch((err) => {
//         console.log("err", err);
//         reject({
//           customError: true,
//           msg: `Vendor not found. (vendor_id: ${entityId})`,
//         });
//       });
//   });
// }

async function getVendor(entityId) {
  try {
    const options = {
      consumer_key: userConfig.token.consumer_key,
      consumer_secret_key: userConfig.token.consumer_secret,
      token: userConfig.token.token_key,
      token_secret: userConfig.token.token_secret,
      realm: userConfig.account,
      url: `${process.env.NS_CUSTOMER_URL}&deploy=2&custscript_mfc_entity_eid=${entityId}`,
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
    if (recordList && recordList.internalid) {
      const record = recordList;
      return record;
    } else {
      throw {
        customError: true,
        msg: `Vendor not found. (vendor_id: ${entityId})`,
      };
    }
  } catch (err) {
    console.error("error", err);
    throw {
      customError: true,
      msg: `Vendor not found. (vendor_id: ${entityId})`,
    };
  }
}

async function putVendor(connections, vendorData, vendor_id) {
  try {
    const vendor_internal_id = vendorData.internalid;
    console.log("vendor_internal_id",vendor_internal_id);
    
    
    const formatData = {
      vendor_internal_id: vendorData?.internalid ?? "",
      vendor_id: vendorData?.entityid ?? "",
      externalId: vendorData?.externalid,
      balance: vendorData?.balance,
      // balancePrimary: vendorData?.balancePrimary,
      companyName: vendorData?.companyname,
      // currency_internal_id: vendorData?.currency.id,
      curr_cd: vendorData?.currency,
      // currency_id: vendorData?.currency.id,
      currency_refName: vendorData?.currency,
      custentity_1099_misc: vendorData?.custentity_1099_misc,
      custentity_11724_pay_bank_fees:
        vendorData?.custentity_11724_pay_bank_fees,
      custentity_2663_payment_method:
        vendorData?.custentity_2663_payment_method,
      // custentity_riv_external_id: vendorData?.custentity_riv_external_id,
      dateCreated: vendorData?.datecreated,
      defaultAddress: vendorData?.address,
      emailTransactions: vendorData?.emailtransactions,
      faxTransactions: vendorData?.faxtransactions,
      // isAutogeneratedRepresentingEntity:
      //   vendorData?.isAutogeneratedRepresentingEntity,
      isInactive: vendorData?.isinactive,
      isJobResourceVend: vendorData?.isjobresourcevend,
      isPerson: vendorData?.isperson,
      lastModifiedDate: vendorData?.lastmodifieddate,
      legalName: vendorData?.legalname,
      phone: vendorData?.phone,
      printTransactions: vendorData?.printtransactions,
      // subsidiaryEdition: vendorData?.subsidiaryEdition,
      unbilledOrders: vendorData?.unbilledorders,
      // unbilledOrdersPrimary: vendorData?.unbilledOrdersPrimary,

      // customForm_id: vendorData?.customForm.id,
      // customForm_refName: vendorData?.customForm.refName,
      // emailPreference_id: vendorData?.emailPreference.id,
      emailPreference_refName: vendorData?.emailpreference,
      // subsidiary_id: vendorData?.subsidiary.id,
      subsidiary_refName: vendorData?.subsidiary,

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

    // console.log("tableStr", tableStr);
    // console.log("valueStr", valueStr);
    // console.log("updateStr", updateStr);

    const upsertQuery = `INSERT INTO ${apDbNamePrev}netsuit_vendors (${tableStr})
                        VALUES (${valueStr}) ON DUPLICATE KEY
                        UPDATE ${updateStr};`;
    console.log("query", upsertQuery);
    await connections.execute(upsertQuery);

    const updateQuery = `UPDATE  ${apDbName} SET
                    processed = null,
                    vendor_internal_id = '${vendor_internal_id}', 
                    processed_date = '${today}' 
                    WHERE vendor_id = '${vendor_id}' and source_system = '${source_system}' and vendor_internal_id is null;`;
    console.log("updateQuery", updateQuery);
    await connections.execute(updateQuery);
  } catch (error) {
    console.log(error);
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
  } catch (error) {}
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
    //cw ar 
    const customerArn = process.env.NETSUITE_AP_CW_VENDOR_STEP_ARN;
    

    const status = "RUNNING";
    const stepfunctions = new AWS.StepFunctions();

    const getExecutionList = async (stateMachineArn) => {
      return new Promise((resolve, reject) => {
        stepfunctions.listExecutions(
          {
            stateMachineArn,
            statusFilter: status,
            maxResults: 2,
          },
          (err, data) => {
            if (err) {
              reject(err);
            } else {
              resolve(data.executions);
            }
          }
        );
      });
    };

    const customerExcList = await getExecutionList(customerArn);
    if (customerExcList.length === 2 && customerExcList[1].status === status) {
      console.log("AP running");
      return true;
    }

    return false;
  } catch (error) {
    return true;
  }
}
