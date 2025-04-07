const nodemailer = require("nodemailer");
const moment = require("moment");
const { sendDevNotification, getConnectionPool } = require("../Helpers/helper");
// const dbname = "dw_prod.";
const dbname = process.env.DATABASE_NAME;
const _ = require("lodash");
const xlsx = require("xlsx");
const mailList = {
    CW: {
        AR: process.env.NETSUIT_AR_CW_ERROR_EMAIL_TO,
        AP: process.env.NETSUIT_AP_CW_ERROR_EMAIL_TO,
    },
    AG: {
        AR: process.env.NETSUIT_AR_AGW_ERROR_EMAIL_TO,
        AP: process.env.NETSUIT_AP_AGW_ERROR_EMAIL_TO,
    },
    TR: {
        AR: process.env.NETSUIT_AR_TR_ERROR_EMAIL_TO,
        AP: process.env.NETSUIT_AP_TR_ERROR_EMAIL_TO,
    },
    M1: {
        AR: process.env.NETSUIT_AR_M1_ERROR_EMAIL_TO,
        AP: process.env.NETSUIT_AP_M1_ERROR_EMAIL_TO,
    },
    INTERCOMPANY: {
        CW: process.env.NETSUIT_INTERCOMPANY_ERROR_EMAIL_TO,
        TR: process.env.NETSUIT_INTERCOMPANY_ERROR_EMAIL_TO,
        WTLL: process.env.NETSUIT_INTERCOMPANY_ERROR_EMAIL_TO,
        CROSSDOCK: process.env.NETSUIT_INTERCOMPANY_ERROR_EMAIL_TO,
    },
    LL: {
        AR: process.env.NETSUIT_AR_LL_ERROR_EMAIL_TO,
        AP: process.env.NETSUIT_AP_LL_ERROR_EMAIL_TO,
    },
    OL: {
        AR: process.env.NETSUIT_AR_MCL_ERROR_EMAIL_TO,
        AP: process.env.NETSUIT_AP_ERROR_EMAIL_TO,
    },
    WT: {
        AR: process.env.NETSUIT_AR_WT_ERROR_EMAIL_TO,
        AP: process.env.NETSUIT_AP_WT_ERROR_EMAIL_TO,
    },
};

const AWS = require("aws-sdk");
const ses = new AWS.SES({ apiVersion: "2010-12-01" });

// const currentDate = "2025-04-1";
const currentDate = moment().format("YYYY-MM-DD");
let connections;

module.exports.handler = async (event) => {
    let sourceSystem = "",
        reportType = "";

    try {
        console.info(event);

        const eventData = event.invPayload.split("_");
        sourceSystem = eventData[0];
        reportType = eventData[1];
        const reportTypeLower = reportType?.toLowerCase();

        connections = getConnectionPool(process.env);
        if (["AR", "AP"].includes(reportType)) {
            await fetchDataAndSendReport({ sourceSystem, reportType, reportTypeLower });
        }
        //* I do not see any report going out for INTERCOMPANY or CROSSDOCK. Commenting this out for now. The queries should be different for those.
        // else if (reportType === "CROSSDOCK") {
        //     await fetchDataAndSendReport({ sourceSystem, reportType: "INTERCOMPANY", intercompanyType: "CROSSDOCK" });
        // }
        // else {
        //     await fetchDataAndSendReport({ sourceSystem, reportType: "INTERCOMPANY", intercompanyType: "AP", reportTypeLower });
        //     await fetchDataAndSendReport({ sourceSystem, reportType: "INTERCOMPANY", intercompanyType: "AR", reportTypeLower });
        // }
        return "Success";
    } catch (error) {
        console.error("error", error);
        await sendDevNotification("INVOICE-REPOR-" + sourceSystem, reportType, error);
        return "Failed";
    } finally {
        connections?.end();
    }
};

/**
 * Fetches data, processes it, and sends a report via email.
 *
 * @async
 * @function fetchDataAndSendReport
 * @param {Object} params - The parameters for the function.
 * @param {string} params.sourceSystem - The source system identifier (e.g., "CW", "AG").
 * @param {string} params.reportType - The type of report (e.g., "AR" or "AP").
 * @param {string} params.reportTypeLower - The lowercase version of the report type.
 * @param {string} [params.intercompanyType] - The intercompany type (e.g., "CROSSDOCK", "AP", "AR").
 * @returns {Promise<void>} Resolves when the report is successfully sent.
 */
async function fetchDataAndSendReport({ sourceSystem, reportType, reportTypeLower, intercompanyType }) {
    const sevenDaysDataRes = await get7DaysData(sourceSystem, reportTypeLower);
    console.info("🙂 -> fetchDataAndSendReport -> sevenDaysDataRes:", sevenDaysDataRes);

    const workbook = initWorkbook();
    const { sevenDaysData, moreThanSevenDaysData } = getSevenAndMoreDaysData(sevenDaysDataRes, sourceSystem, reportType);

    write7AndMoreThan7DaysData(workbook, sevenDaysData, "Age 0-7 Days");
    write7AndMoreThan7DaysData(workbook, moreThanSevenDaysData, "Age > 7 Days");

    const rawReportData = await getReportData(sourceSystem, reportType, intercompanyType);

    //* Raw Data
    const preparedRawData = prepareRawData(rawReportData, reportType);
    commonWriter(workbook, preparedRawData, "Raw Error Data");

    //* Pivot Table data
    const pivotData = getPivotTableData(rawReportData);
    const pivotExcelData = convertPivotToExcelFormat(pivotData);
    writePivotDataToExcel(workbook, pivotExcelData);

    //* Success Summary
    const successSummaryData = await getSuccessSummary(sourceSystem, reportTypeLower);

    const successSummaryRawCM = await getSuccessRawData(sourceSystem, reportTypeLower, "CM");

    const successSummaryRawIN = await getSuccessRawData(sourceSystem, reportTypeLower, "IN");

    //* Success Summary
    const successSummaryAOA = getSuccessSummaryData(successSummaryData, "CW");
    writeSuccessSummaryData(workbook, successSummaryAOA);

    //* CM successes
    const cmSuccessAOA = getSuccessAOARawData(successSummaryRawCM, reportType);
    commonWriter(workbook, cmSuccessAOA, "Raw data success (CM)");

    //* IN successes
    const inSuccessAOA = getSuccessAOARawData(successSummaryRawIN, reportType);
    commonWriter(workbook, inSuccessAOA, "Raw data success (IN)");

    //* Error Resolution Guide
    const errorResolutionGuide = getErrorResolutionGuide();
    commonWriter(workbook, errorResolutionGuide, "Error Resolution Guide");

    //* Integration Schedule
    const integrationSchedule = getIntegrationSchedule();
    commonWriter(workbook, integrationSchedule, "Integration Schedule");

    const attachmentBuffer = writeWorkbook(workbook);

    await sendFailedRecordsAlert(attachmentBuffer, sourceSystem, reportType);

    await updateReportData(sourceSystem, reportType, rawReportData);
}

/**
 * Retrieves a summary of successfully processed invoices from the database.
 *
 * @async
 * @function getSuccessSummary
 * @param {string} sourceSystem - The source system identifier (e.g., "CW", "AG").
 * @param {string} type - The type of report (e.g., "AR" or "AP").
 * @returns {Promise<Array>} A promise that resolves to an array of summary data,
 * including invoice type, total amount, and count of invoices.
 */
async function getSuccessSummary(sourceSystem, type) {
    const query = `select invoice_type, sum(total), count(invoice_nbr) from interface_${type}
    where source_system = '${sourceSystem}' and processed = 'P' and processed_date = '${currentDate}' group by 1`;
    console.info(query);
    return await executeQuery(query);
}

/**
 * Retrieves raw data for successfully processed invoices of a specific type.
 *
 * @async
 * @function getSuccessRawData
 * @param {string} sourceSystem - The source system identifier (e.g., "CW", "AG").
 * @param {string} type - The type of report (e.g., "AR" or "AP").
 * @param {string} invoiceType - The type of invoice (e.g., "CM" or "IN").
 * @returns {Promise<Array>} A promise that resolves to an array of raw data rows.
 */
async function getSuccessRawData(sourceSystem, type, invoiceType) {
    const query = `select 
        *
    from interface_${type}
    where source_system = '${sourceSystem}' 
    and processed = 'P' 
    and processed_date = '${currentDate}' 
    and invoice_type = '${invoiceType}'`;
    return await executeQuery(query);
}

/**
 * Retrieves data for invoices aged 0-7 days from the database.
 *
 * @async
 * @function get7DaysData
 * @param {string} sourceSystem - The source system identifier (e.g., "CW", "AG").
 * @param {string} type - The type of report (e.g., "AP" or "AR").
 * @returns {Promise<Array>} - A promise that resolves to an array of rows containing:
 *   - `cast(invoice_date as date)` (Date): The invoice date.
 *   - `count(invoice_nbr)` (number): The count of invoices.
 *   - `sum(total)` (number): The total amount of invoices.
 * @throws {Error} - Throws an error if the query execution fails.
 */
async function get7DaysData(sourceSystem, type) {
    const query = `select cast(invoice_date as date), count(invoice_nbr), sum(total) from interface_${type}_api_logs where source_system = '${sourceSystem}' and current_dt = '${currentDate}' group by 1 order by 1`;
    console.info(query);
    return await executeQuery(query);
}

/**
 * Executes a SQL query using the database connection and returns the result rows.
 *
 * @param {string} query - The SQL query string to be executed.
 * @returns {Promise<Array>} A promise that resolves to an array of result rows.
 * @throws {Error} Throws an error if the query execution fails.
 */
async function executeQuery(query) {
    try {
        const [rows] = await connections.query(query);
        return rows;
    } catch (error) {
        throw error;
    }
}

/**
 * Sends an email alert with an attached Excel report for failed records.
 *
 * @async
 * @function sendFailedRecordsAlert
 * @param {Buffer} attachmentBuffer - The buffer containing the Excel file to be attached.
 * @param {string} sourceSystem - The source system identifier (e.g., "CW", "AG").
 * @param {string} type - The type of report (e.g., "AP" or "AR").
 * @returns {Promise<void>} Resolves when the email is sent successfully or logs an error if it fails.
 *
 * @description
 * This function sends an email alert using AWS SES via Nodemailer. The email includes an HTML body
 * with details about the report and an Excel file attachment. The email is sent to a predefined list
 * of recipients, and the subject and filename are dynamically generated based on the source system,
 * report type, and current date.
 *
 * @throws {Error} Logs an error if the email fails to send.
 */
async function sendFailedRecordsAlert(attachmentBuffer, sourceSystem, type) {
    const senderEmail = "no-reply@omnilogistics.com";
    let recipientEmails = _.get(mailList, `${sourceSystem}.${type}`, "BizCloudDev@omnilogistics.com");
    // let recipientEmails = ["juddin@omnilogistics.com", "skunapareddy@omnilogistics.com"];
    const filename = `Netsuite-${sourceSystem}-${type}-${process.env.STAGE}-report-${moment().format("YYYY-MM-DD")}.xlsx`;
    const subject = `Netsuite ${sourceSystem} ${type} Report ${process.env.STAGE.toUpperCase()}`;

    if (!senderEmail) {
        console.error("SES sender email not set in environment variables.");
        return;
    }

    if (typeof recipientEmails === "string") {
        recipientEmails = recipientEmails.split(",").map((email) => email.trim());
    }

    const htmlBody = `<html>
      <head>
        <style>
          body {
            font-family: 'Helvetica Neue', Arial, sans-serif;
            margin: 20px;
            background-color: #f9f9f9;
            color: #333;
          }
          .container {
            background-color: #ffffff;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
          }
          h1 {
            color:rgb(25, 220, 68);
            text-align: center;
            font-size: 22px;
            margin-bottom: 10px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>${subject}</h1>
          <p>Hello Team,</p>
          <p>Attached the file for your reference.</p>
          </br>
          </br>
          </br>
          <p>Note:</p>
          <ol>
            <li>The attached spread is only based on the invoices that were trying to post to NS, They got picked up today but different Posted dates from the TMS system.</li>
            <li>The spreadsheet has 3 internal sheets.
            <li>The sheet name with Age 0-7 Days, represents the invoices which are failing to post to NS. (posted date with in the last 7 days)</li>
            <li>The sheet name with Age > 7 Days, represents the invoices which are failing to post to NS. (posted date beyond the last 7 days)</li>
            <li>The sheet name with Top 10 Error messages, represents the most repeatable error messages.</li>
            <li>The raw error report is added.</li>
            <li>The resolution guide is added.</li>
            <li>The schedule timings guide is added.</li>
          </ol>
        </div>
      </body>
    </html>`;

    const transporter = nodemailer.createTransport({
        SES: { ses, aws: { SendRawEmail: true } },
    });

    try {
        const messageOptions = {
            from: senderEmail,
            to: recipientEmails,
            subject: `${subject} ${moment().format("YYYY-MM-DD")}`,
            html: htmlBody,
            attachments: [
                {
                    filename,
                    content: attachmentBuffer,
                },
            ],
        };

        const result = await transporter.sendMail(messageOptions);
        console.info(`Alert email sent successfully to ${recipientEmails}. MessageId: ${result.messageId}`);
    } catch (error) {
        console.error(`Failed to send alert email via SES: ${error}`);
    }
}

/**
 * Processes invoice data and categorizes it into two groups: invoices aged 0-7 days
 * and invoices aged more than 7 days. Returns the categorized data in a structured format.
 *
 * @param {Array<Object>} data - The array of invoice data objects to process.
 * @param {string} sourceSystem - The source system identifier for the report.
 * @param {string} reportType - The type of report being generated.
 * @returns {Object} An object containing two properties:
 *   - `sevenDaysData` {Array<Array<string|number>>}: Data for invoices aged 0-7 days.
 *   - `moreThanSevenDaysData` {Array<Array<string|number>>}: Data for invoices aged more than 7 days.
 */
function getSevenAndMoreDaysData(data = [], sourceSystem, reportType) {
    const sevenDaysData = [
        ["Invoices", "Source System", "Process Status", "Processed Date", "Invoice Date", "Age 0-7 Days"],
        ["", "", "", "", "", "Invoices", "Amount"],
    ];
    const moreThanSevenDaysData = [
        ["Invoices", "Source System", "Process Status", "Processed Date", "Invoice Date", "Age > 7 Days"],
        ["", "", "", "", "", "Invoices", "Amount"],
    ];

    data.forEach((item) => {
        const date = moment(item["cast(invoice_date as date)"]);
        const now = moment();
        const diff = now.diff(date, "days");

        const postedDate = moment(_.get(item, "cast(invoice_date as date)", "")).format("YYYY-MM-DD");

        if (diff <= 7) {
            sevenDaysData.push(["", "", "", "", postedDate, item["count(invoice_nbr)"], parseFloat(item["sum(total)"]).toFixed(2)]);
        } else {
            moreThanSevenDaysData.push(["", "", "", "", postedDate, item["count(invoice_nbr)"], parseFloat(item["sum(total)"]).toFixed(2)]);
        }
    });

    if (_.get(sevenDaysData, "[2]", []).length) {
        _.set(sevenDaysData, "[2][0]", reportType);
        _.set(sevenDaysData, "[2][1]", sourceSystem);
        _.set(sevenDaysData, "[2][2]", "F");
        _.set(sevenDaysData, "[2][3]", moment().format("YYYY-MM-DD"));
    }
    if (_.get(moreThanSevenDaysData, "[2]", []).length) {
        _.set(moreThanSevenDaysData, "[2][0]", reportType);
        _.set(moreThanSevenDaysData, "[2][1]", sourceSystem);
        _.set(moreThanSevenDaysData, "[2][2]", "F");
        _.set(moreThanSevenDaysData, "[2][3]", moment().format("YYYY-MM-DD"));
    }

    return { sevenDaysData, moreThanSevenDaysData };
}

/**
 * Initializes and returns a new workbook object.
 *
 * @returns {Object} A new workbook instance created using the xlsx library.
 */
function initWorkbook() {
    return xlsx.utils.book_new();
}

/**
 * Writes the given workbook to a buffer in XLSX format with specified options.
 *
 * @param {Object} workbook - The workbook object to be written.
 * @returns {Buffer} The generated buffer containing the XLSX data.
 */
function writeWorkbook(workbook) {
    const buffer = xlsx.write(workbook, {
        type: "buffer",
        bookType: "xlsx",
        compression: true,
        cellStyles: true,
    });

    return buffer;
}

/**
 * Writes data to an Excel workbook, creating a worksheet with specified column widths,
 * merged cells, and a default sheet name if not provided.
 *
 * @param {Object} workbook - The Excel workbook object to which the worksheet will be appended.
 * @param {Array<Array<any>>} data - A 2D array representing the data to be written to the worksheet.
 * @param {string} [sheetName="Sheet1"] - The name of the worksheet to be created. Defaults to "Sheet1".
 *
 * @returns {void}
 */
function write7AndMoreThan7DaysData(workbook, data, sheetName = "Sheet1") {
    const worksheet = xlsx.utils.aoa_to_sheet(data);

    const colWidths = [
        { wch: 10 }, // Invoices
        { wch: 15 }, // Source System
        { wch: 15 }, // Process stati
        { wch: 15 }, // Processed Date
        { wch: 25 }, // Posted Date
        { wch: 15 }, // Age 0-7 Days Invoices
        { wch: 15 }, // Age 0-7 Days Amount
    ];
    worksheet["!cols"] = colWidths;

    worksheet["!merges"] = [
        { s: { c: 0, r: 2 }, e: { c: 0, r: data.length - 1 } },
        { s: { c: 1, r: 2 }, e: { c: 1, r: data.length - 1 } },
        { s: { c: 2, r: 2 }, e: { c: 2, r: data.length - 1 } },
        { s: { c: 3, r: 2 }, e: { c: 3, r: data.length - 1 } },
        { s: { c: 5, r: 0 }, e: { c: 6, r: 0 } },
    ];
    xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
}

/**
 * Retrieves report data based on the source system, report type, and intercompany type.
 *
 * @param {string} sourceSystem - The source system identifier (e.g., "CW", "AG").
 * @param {string} type - The type of report ("AP" or "AR").
 * @param {string} [intercompanyType] - The intercompany type (e.g., "CROSSDOCK", "AP", "AR").
 * @returns {Promise<Array<Object>>} - A promise that resolves to an array of report data objects.
 * Each object contains fields such as `source_system`, `error_msg`, `file_nbr`, and more.
 * @throws {Error} - Throws an error if the query execution fails or if there is an issue with the data retrieval.
 */
async function getReportData(sourceSystem, type, intercompanyType) {
    try {
        let query = "";
        if (type === "AP") {
            // AP
            const table = `${dbname}interface_ap_api_logs`;
            const queryNonVenErr = `select source_system,error_msg,file_nbr,vendor_id,subsidiary,invoice_nbr,invoice_date,housebill_nbr,master_bill_nbr,invoice_type,controlling_stn,currency,charge_cd,total,posted_date,gc_code,tax_code,unique_ref_nbr,internal_ref_nbr,intercompany,id,epay_status,system_id
                from ${table} where source_system = '${sourceSystem}' and is_report_sent ='N' and 
                error_msg NOT LIKE '%Vendor not found%'`;

            console.info(queryNonVenErr);

            const nonVenErrdata = await executeQuery(queryNonVenErr);
            console.info("nonVenErrdata", nonVenErrdata.length);
            const queryVenErr = `select vendor_id from ${table} where source_system = '${sourceSystem}' 
                            and is_report_sent ='N' and error_msg LIKE '%Vendor not found%'`;
            let mainQuery = "";
            if (sourceSystem == "CW") {
                mainQuery = `select ${dbname}interface_ap.*, CONCAT('Vendor not found. (vendor_id: ', CAST(vendor_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
                from ${dbname}interface_ap where source_system = '${sourceSystem}' and processed ='F' and vendor_id in (${queryVenErr})
                GROUP BY invoice_nbr, vendor_id, invoice_type, gc_code, subsidiary, source_system;`;
            } else if (sourceSystem == "AG") {
                mainQuery = `select ${dbname}interface_ap.*, CONCAT('Vendor not found. (vendor_id: ', CAST(vendor_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
                from ${dbname}interface_ap where source_system = '${sourceSystem}' and processed ='F' and vendor_id in (${queryVenErr})
                GROUP BY invoice_nbr, vendor_id, invoice_type, gc_code, subsidiary, source_system;`;
            } else if (sourceSystem == "M1") {
                mainQuery = `select ${dbname}interface_ap.*, CONCAT('Vendor not found. (vendor_id: ', CAST(vendor_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
                from ${dbname}interface_ap where source_system = '${sourceSystem}' and processed ='F' and vendor_id in (${queryVenErr})
                GROUP BY invoice_nbr, vendor_id, invoice_type, gc_code, subsidiary, source_system;`;
            } else if (sourceSystem == "TR") {
                mainQuery = `select ${dbname}interface_ap.*, CONCAT('Vendor not found. (vendor_id: ', CAST(vendor_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
                from ${dbname}interface_ap where source_system = '${sourceSystem}' and processed ='F' and vendor_id in (${queryVenErr})
                GROUP BY invoice_nbr, vendor_id, invoice_type, gc_code, subsidiary, source_system;`;
            } else if (sourceSystem == "LL") {
                mainQuery = `select ${dbname}interface_ap_epay.*, CONCAT('Vendor not found. (vendor_id: ', CAST(vendor_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
                from ${dbname}interface_ap_epay where source_system = '${sourceSystem}' and processed ='F' and vendor_id in (${queryVenErr})
                GROUP BY invoice_nbr, vendor_id, invoice_type, gc_code, subsidiary, source_system;`;
            } else if (sourceSystem == "WT") {
                mainQuery = `select ${dbname}interface_ap.*, CONCAT('Vendor not found. (vendor_id: ', CAST(vendor_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
                from ${dbname}interface_ap where source_system = '${sourceSystem}' and processed ='F' and vendor_id in (${queryVenErr})
                GROUP BY invoice_nbr, vendor_id, invoice_type;`;
            } else if (sourceSystem == "OL") {
                mainQuery = `select ${dbname}interface_ap.*, CONCAT('Vendor not found. (vendor_id: ', CAST(vendor_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
                from ${dbname}interface_ap where source_system = '${sourceSystem}' and processed ='F' and vendor_id in (${queryVenErr})
                GROUP BY invoice_nbr, vendor_id, invoice_type, file_nbr;`;
            }
            console.info("mainQuery", mainQuery);
            const data = await executeQuery(mainQuery);
            console.info("data", data.length);
            if (data && data.length > 0) {
                const formatedData = data.map((e) => ({
                    source_system: e?.source_system ?? "",
                    error_msg: e?.error_msg ?? "",
                    file_nbr: e?.file_nbr ?? "",
                    vendor_id: e?.vendor_id ?? "",
                    subsidiary: e?.subsidiary ?? "",
                    invoice_nbr: e?.invoice_nbr ?? "",
                    invoice_date: e?.invoice_date ?? "",
                    finalizedby: e?.finalizedby ?? "",
                    housebill_nbr: e?.housebill_nbr ?? "",
                    master_bill_nbr: e?.master_bill_nbr ?? "",
                    invoice_type: e?.invoice_type ?? "",
                    controlling_stn: e?.controlling_stn ?? "",
                    currency: e?.currency ?? "",
                    charge_cd: e?.charge_cd ?? "",
                    total: e?.total ?? "",
                    posted_date: e?.posted_date ?? "",
                    gc_code: e?.gc_code ?? "",
                    tax_code: e?.tax_code ?? "",
                    unique_ref_nbr: e?.unique_ref_nbr ?? "",
                    internal_ref_nbr: e?.internal_ref_nbr ?? "",
                    intercompany: e?.intercompany ?? "",
                    id: e?.id ?? "",
                    epay_status: e?.status ?? "",
                    system_id: e?.system_id ?? "",
                }));
                return [...formatedData, ...nonVenErrdata];
            } else {
                return nonVenErrdata;
            }
        } else if (type === "AR") {
            // AR
            const table = `${dbname}interface_ar_api_logs`;
            const queryNonCuErr = `select source_system,error_msg,file_nbr,customer_id,subsidiary,invoice_nbr,invoice_date,housebill_nbr,master_bill_nbr,invoice_type,controlling_stn,charge_cd,curr_cd,total,posted_date,gc_code,tax_code,unique_ref_nbr,internal_ref_nbr,order_ref,ee_invoice,intercompany,id 
                from ${table} where source_system = '${sourceSystem}' and is_report_sent ='N' and 
                error_msg NOT LIKE '%Customer not found%'`;
            const nonCuErrdata = await executeQuery(queryNonCuErr);
            console.info("nonCuErrdata", nonCuErrdata.length);

            const queryCuErr = `select customer_id from ${table} where source_system = '${sourceSystem}' 
                            and is_report_sent ='N' and error_msg LIKE '%Customer not found%'`;
            let mainQuery = "";
            if (sourceSystem == "CW") {
                mainQuery = `select ${dbname}interface_ar.*, CONCAT('Customer not found. (customer_id: ', CAST(customer_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
                from ${dbname}interface_ar where source_system = '${sourceSystem}' and processed ='F' and customer_id in (${queryCuErr})
                GROUP BY invoice_nbr, invoice_type, gc_code, subsidiary`;
            } else if (sourceSystem == "AG") {
                mainQuery = `select ${dbname}interface_ar.*, CONCAT('Customer not found. (customer_id: ', CAST(customer_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
                from ${dbname}interface_ar where source_system = '${sourceSystem}' and processed ='F' and customer_id in (${queryCuErr})
                GROUP BY invoice_nbr, invoice_type, gc_code, subsidiary`;
            } else if (sourceSystem == "M1") {
                mainQuery = `select ${dbname}interface_ar.*, CONCAT('Customer not found. (customer_id: ', CAST(customer_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
                from ${dbname}interface_ar where source_system = '${sourceSystem}' and processed ='F' and customer_id in (${queryCuErr})
                GROUP BY invoice_nbr, invoice_type, gc_code, subsidiary`;
            } else if (sourceSystem == "TR") {
                mainQuery = `select ${dbname}interface_ar.*, CONCAT('Customer not found. (customer_id: ', CAST(customer_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
                from ${dbname}interface_ar where source_system = '${sourceSystem}' and processed ='F' and customer_id in (${queryCuErr})
                GROUP BY invoice_nbr, invoice_type, gc_code, subsidiary`;
            } else if (sourceSystem == "LL") {
                mainQuery = `select ${dbname}interface_ar.*, CONCAT('Customer not found. (customer_id: ', CAST(customer_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
                from ${dbname}interface_ar where source_system = '${sourceSystem}' and processed ='F' and customer_id in (${queryCuErr})
                GROUP BY invoice_nbr, invoice_type, gc_code, subsidiary`;
            } else if (sourceSystem == "WT") {
                mainQuery = `select ${dbname}interface_ar.*, CONCAT('Customer not found. (customer_id: ', CAST(customer_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
                from ${dbname}interface_ar where source_system = 'WT' and processed ='F' and customer_id in (${queryCuErr})
                GROUP BY invoice_nbr, invoice_type;`;
            } else if (sourceSystem == "OL") {
                mainQuery = `select ${dbname}interface_ar.*, CONCAT('Customer not found. (customer_id: ', CAST(customer_id AS CHAR), ') Subsidiary: ', subsidiary) AS error_msg
                from ${dbname}interface_ar where source_system = '${sourceSystem}' and processed ='F' and customer_id in (${queryCuErr})
                GROUP BY invoice_nbr, invoice_type, file_nbr;`;
            }
            console.info("mainQuery", mainQuery);
            const data = await executeQuery(mainQuery);
            console.info("data", data.length);
            if (data && data.length > 0) {
                const formatedData = data.map((e) => ({
                    source_system: e?.source_system ?? "",
                    error_msg: e?.error_msg ?? "",
                    file_nbr: e?.file_nbr ?? "",
                    customer_id: e?.customer_id ?? "",
                    subsidiary: e?.subsidiary ?? "",
                    invoice_nbr: e?.invoice_nbr ?? "",
                    invoice_date: e?.invoice_date ?? "",
                    finalized_by: e?.finalized_by ?? "",
                    housebill_nbr: e?.housebill_nbr ?? "",
                    master_bill_nbr: e?.master_bill_nbr ?? "",
                    invoice_type: e?.invoice_type ?? "",
                    controlling_stn: e?.controlling_stn ?? "",
                    charge_cd: e?.charge_cd ?? "",
                    curr_cd: e?.curr_cd ?? "",
                    total: e?.total ?? "",
                    posted_date: e?.posted_date ?? "",
                    gc_code: e?.gc_code ?? "",
                    tax_code: e?.tax_code ?? "",
                    unique_ref_nbr: e?.unique_ref_nbr ?? "",
                    internal_ref_nbr: e?.internal_ref_nbr ?? "",
                    order_ref: e?.order_ref ?? "",
                    ee_invoice: e?.ee_invoice ?? "",
                    intercompany: e?.intercompany ?? "",
                    id: e?.id ?? "",
                }));
                return [...formatedData, ...nonCuErrdata];
            } else {
                return nonCuErrdata;
            }
        } else {
            if (intercompanyType === "CROSSDOCK") {
                query = `select distinct ia.* from ${dbname}interface_intracompany_api_logs ia
            where ia.source_system = '${sourceSystem}' and ia.is_report_sent = 'N'`;

                console.info("query:getReportData", query);
                const data = await executeQuery(query);
                console.info("query:data", data.length);
                if (data && data.length > 0) {
                    return data.map((e) => ({
                        source_system: e.source_system,
                        error_msg: e.error_msg,
                        ...e,
                    }));
                } else {
                    return [];
                }
            }
            // INTERCOMPANY
            if (sourceSystem === "CW") {
                if (intercompanyType === "AP") {
                    query = `select distinct ia.*,ial.error_msg,ial.id  from ${dbname}interface_ap ia 
            join ${dbname}interface_intercompany_api_logs ial on ia.source_system=ial.source_system and 
            ia.internal_id=ial.ap_internal_id and ia.file_nbr= ial.file_nbr
            where ia.intercompany ='Y' and ial.source_system = '${sourceSystem}' and ial.is_report_sent = 'N'`;
                } else {
                    query = `
            select distinct ar.*, ial.error_msg, ial.id from ${dbname}interface_ar ar
            join ${dbname}interface_intercompany_api_logs ial on ial.source_system = ar.source_system 
            and ial.ar_internal_id  = ar.internal_id and ial.file_nbr = ar.file_nbr 
            where ar.intercompany ='Y' and ial.source_system = '${sourceSystem}' and ial.is_report_sent ='N'`;
                }
            } else if (sourceSystem === "AG") {
                if (intercompanyType === "AP") {
                    query = `select distinct ia.*,ial.error_msg,ial.id  from ${dbname}interface_ap ia 
            join ${dbname}interface_intercompany_api_logs ial on ia.source_system=ial.source_system and 
            ia.internal_id=ial.ap_internal_id and ia.file_nbr= ial.file_nbr
            where ia.intercompany ='Y' and ial.source_system = '${sourceSystem}' and ial.is_report_sent = 'N'`;
                } else {
                    query = `
            select distinct ar.*, ial.error_msg, ial.id from ${dbname}interface_ar ar
            join ${dbname}interface_intercompany_api_logs ial on ial.source_system = ar.source_system 
            and ial.ar_internal_id  = ar.internal_id and ial.file_nbr = ar.file_nbr 
            where ar.intercompany ='Y' and ial.source_system = '${sourceSystem}' and ial.is_report_sent ='N'`;
                }
            } else if (sourceSystem === "TR") {
                if (intercompanyType === "AP") {
                    query = `select distinct ia.*,ial.error_msg,ial.id  from ${dbname}interface_ap ia 
            join ${dbname}interface_intercompany_api_logs ial on ia.source_system=ial.source_system and 
            ia.internal_id=ial.ap_internal_id and ia.file_nbr= ial.file_nbr
            where ia.intercompany ='Y' and ial.source_system = '${sourceSystem}' and ial.is_report_sent = 'N'`;
                } else {
                    query = `
            select distinct ar.*, ial.error_msg, ial.id from ${dbname}interface_ar ar
            join ${dbname}interface_intercompany_api_logs ial on ial.source_system = ar.source_system 
            and ial.ar_internal_id  = ar.internal_id and ial.file_nbr = ar.file_nbr 
            where ar.intercompany ='Y' and ial.source_system = '${sourceSystem}' and ial.is_report_sent ='N'`;
                }
            } else if (sourceSystem === "LL") {
                if (intercompanyType === "AP") {
                    query = `select distinct ia.*,ial.error_msg,ial.id  from ${dbname}interface_ap ia 
            join ${dbname}interface_intercompany_api_logs ial on concat('LL', ia.source_system)=ial.source_system and 
            ia.internal_id=ial.ap_internal_id 
            where ia.intercompany ='Y' and ial.source_system in ('LLWT', 'LLTR', 'LLM1') and ial.is_report_sent = 'N'`;
                } else {
                    query = `
            select distinct ar.*, ial.error_msg, ial.id from ${dbname}interface_ar ar
            join ${dbname}interface_intercompany_api_logs ial on ial.source_system = concat(ar.source_system, 'WT')
            and ial.ar_internal_id  = ar.internal_id 
            where ar.intercompany ='Y' and ial.source_system ='LLWT' and ial.is_report_sent ='N'
            union
            select distinct ar.*, ial.error_msg, ial.id from ${dbname}interface_ar ar
            join ${dbname}interface_intercompany_api_logs ial on ial.source_system = concat(ar.source_system, 'TR')
            and ial.ar_internal_id  = ar.internal_id 
            where ar.intercompany ='Y' and ial.source_system ='LLTR' and ial.is_report_sent ='N'
            union
            select distinct ar.*, ial.error_msg, ial.id from ${dbname}interface_ar ar
            join ${dbname}interface_intercompany_api_logs ial on ial.source_system = concat(ar.source_system, 'M1')
            and ial.ar_internal_id  = ar.internal_id 
            where ar.intercompany ='Y' and ial.source_system ='LLM1' and ial.is_report_sent ='N'`;
                }
            }
            console.info("query:getReportData", query);
            const data = await executeQuery(query);
            console.info("query:data", data.length);
            if (data && data.length > 0) {
                return data.map((e) => ({
                    source_system: e.source_system,
                    error_msg: e.error_msg,
                    ...e,
                }));
            } else {
                return [];
            }
        }
    } catch (error) {
        console.error("error:getReportData", error);
        return [];
    }
}

/**
 * Transforms the input data object by mapping its fields to a new structure
 * based on a predefined mapping and adds an error category derived from the error message.
 *
 * @param {Object} item - The input data object to be transformed.
 * @param {string} [item.source_system] - The source system of the data.
 * @param {string} [item.error_msg] - The error message associated with the data.
 * @param {string} [item.file_nbr] - The file number.
 * @param {string} [item.vendor_id] - The vendor ID.
 * @param {string} [item.subsidiary] - The subsidiary information.
 * @param {string} [item.invoice_nbr] - The invoice number.
 * @param {string} [item.invoice_date] - The invoice date.
 * @param {string} [item.finalizedby] - The user who finalized the data.
 * @param {string} [item.housebill_nbr] - The house bill number.
 * @param {string} [item.master_bill_nbr] - The master bill number.
 * @param {string} [item.invoice_type] - The type of invoice.
 * @param {string} [item.controlling_stn] - The controlling station.
 * @param {string} [item.currency] - The currency used.
 * @param {string} [item.charge_cd] - The charge code.
 * @param {number} [item.total] - The total amount.
 * @param {string} [item.posted_date] - The posted date.
 * @param {string} [item.gc_code] - The GC code.
 * @param {string} [item.tax_code] - The tax code.
 * @param {string} [item.unique_ref_nbr] - The unique reference number.
 * @param {string} [item.internal_ref_nbr] - The internal reference number.
 * @param {boolean} [item.intercompany] - Indicates if the data is intercompany.
 * @param {string} [item.id] - The unique identifier.
 * @param {string} [item.epay_status] - The ePay status.
 * @param {string} [item.system_id] - The system ID.
 * @returns {Object} The transformed data object with mapped fields and an added error category.
 */
function transformData(item) {
    const fields = {
        SourceSystem: "source_system",
        ErrorMsg: "error_msg",
        FileNbr: "file_nbr",
        VendorId: "vendor_id",
        Subsidiary: "subsidiary",
        InvoiceNbr: "invoice_nbr",
        InvoiceDate: "invoice_date",
        FinalizedBy: "finalizedby",
        HousebillNbr: "housebill_nbr",
        MasterBillNbr: "master_bill_nbr",
        InvoiceType: "invoice_type",
        ControllingStn: "controlling_stn",
        Currency: "currency",
        ChargeCd: "charge_cd",
        Total: "total",
        PostedDate: "posted_date",
        GcCode: "gc_code",
        TaxCode: "tax_code",
        UniqueRefNbr: "unique_ref_nbr",
        InternalRefNbr: "internal_ref_nbr",
        Intercompany: "intercompany",
        Id: "id",
        EpayStatus: "epay_status",
        SystemId: "system_id",
    };

    const transformed = {};
    Object.entries(fields).forEach(([key, value]) => {
        transformed[key] = _.get(item, value, "");
    });
    transformed.ErrorCategory = getErrorMessage(transformed.ErrorMsg);

    return transformed;
}

/**
 * Calculates aggregate values from the provided data.
 *
 * @param {Array<Object>} data - An array of objects representing invoice data.
 * @param {string} data[].InvoiceNbr - The invoice number of an item.
 * @param {string|number} data[].Total - The total amount of an item, as a string or number.
 * @returns {Object} An object containing the calculated aggregates:
 *   - `Count of InvoiceNbr`: The count of unique invoice numbers.
 *   - `Sum of Total`: The sum of the `Total` values, formatted as a string with two decimal places.
 */
function calculateAggregates(data) {
    return {
        "Count of InvoiceNbr": _.size(_.uniqBy(data, "InvoiceNbr")),
        "Sum of Total": parseFloat(
            _.sumBy(data, (item) => {
                const value = parseFloat(item.Total);
                return isNaN(value) ? 0 : value;
            })
        ).toFixed(2),
    };
}

/**
 * Processes error messages by grouping them based on their error category,
 * simplifying the data structure, and calculating aggregates for each group.
 *
 * @param {Array<Object>} data - An array of objects representing error data.
 * Each object should contain at least the properties `ErrorCategory`, `InvoiceNbr`, and `Total`.
 *
 * @returns {Object} An object where each key is an error category, and the value is an object
 * containing the simplified data and calculated aggregates for that category.
 *
 * The structure of the returned object is:
 * {
 *   [errorCategory]: {
 *     data: Array<{ InvoiceNbr: string, Total: number }>,
 *     ...aggregates
 *   }
 * }
 *
 * @throws {Error} If the input data is not an array or contains invalid structure.
 */
function processErrorMessages(data) {
    const groupByErrorMessage = _.groupBy(data, "ErrorCategory");

    return Object.entries(groupByErrorMessage).reduce((acc, [errorKey, errorData]) => {
        const simplifiedData = errorData.map((e) => ({
            InvoiceNbr: _.get(e, "InvoiceNbr"),
            Total: _.get(e, "Total"),
        }));

        acc[errorKey] = {
            data: simplifiedData,
            ...calculateAggregates(errorData),
        };
        return acc;
    }, {});
}

/**
 * Processes raw data to generate pivot table data by transforming, grouping,
 * and aggregating it based on source systems and error messages.
 *
 * @param {Array<Object>} data - The raw data to be processed.
 * @param {string} data[].SourceSystem - The source system identifier for each data entry.
 * @returns {Object} An object containing aggregated data and grouped information
 *                   by source systems, including error message processing results.
 */
function getPivotTableData(data) {
    // Step 1: Transform raw data
    const transformedData = data.map(transformData);

    // Step 2: Group by source system
    const groupedBySource = _.groupBy(transformedData, "SourceSystem");

    const totalAggregates = calculateAggregates(transformedData);

    // Step 3: Process each source system group
    const groupedBySourceData = Object.entries(groupedBySource).reduce((acc, [sourceKey, sourceData]) => {
        // Calculate aggregates for the source system
        const sourceAggregates = calculateAggregates(sourceData);

        // Process error messages for this source system
        const errorGroups = processErrorMessages(sourceData);

        // Combine all information for this source system
        acc[sourceKey] = {
            ...sourceAggregates,
            ...errorGroups,
        };

        return acc;
    }, {});
    return {
        ...totalAggregates,
        ...groupedBySourceData,
    };
}

/**
 * Converts pivot data into a format suitable for Excel, including headers,
 * source system rows, error categories, and optional individual invoice details.
 *
 * @param {Object} pivotData - The pivot data to be converted. The object should
 * contain keys representing source systems, each with their own data, as well
 * as aggregate keys like "Count of InvoiceNbr" and "Sum of Total".
 *
 * @returns {Array<Array<string|number>>} A 2D array representing the Excel-compatible
 * format. Each inner array represents a row, with columns for "Row Labels",
 * "Count of InvoiceNbr", and "Sum of Total".
 *
 * @example
 * const pivotData = {
 *   "SourceSystem1": {
 *     "Count of InvoiceNbr": 10,
 *     "Sum of Total": 5000,
 *     "ErrorCategory1": {
 *       "Count of InvoiceNbr": 5,
 *       "Sum of Total": 2500,
 *       data: [
 *         { InvoiceNbr: "INV001", Total: 500 },
 *         { InvoiceNbr: "INV002", Total: 2000 }
 *       ]
 *     }
 *   },
 *   "Count of InvoiceNbr": 15,
 *   "Sum of Total": 7500
 * };
 *
 * const result = convertPivotToExcelFormat(pivotData);
 * console.log(result);
 */
function convertPivotToExcelFormat(pivotData) {
    const result = [];

    // Add headers
    result.push(["Row Labels", "Count of InvoiceNbr", "Sum of Total"]);

    // Process each source system
    Object.entries(pivotData).forEach(([sourceSystem, sourceData]) => {
        if (sourceSystem === "Count of InvoiceNbr" || sourceSystem === "Sum of Total") {
            return; // Skip the aggregates
        }
        // Add source system row
        result.push([sourceSystem, sourceData["Count of InvoiceNbr"], sourceData["Sum of Total"]]);

        // Add error categories for this source system
        Object.entries(sourceData).forEach(([key, value]) => {
            // Skip the count and sum keys as they're already added
            if (key !== "Count of InvoiceNbr" && key !== "Sum of Total") {
                result.push([
                    `  ${key}`, // Add space for indentation
                    value["Count of InvoiceNbr"],
                    value["Sum of Total"],
                ]);

                // Optionally, add individual invoice details
                if (value.data) {
                    value.data.forEach((invoice) => {
                        result.push([
                            `    ${invoice.InvoiceNbr}`, // Add more spaces for further indentation
                            1,
                            invoice.Total,
                        ]);
                    });
                }
            }
        });
    });

    result.push(["Grand Total", pivotData["Count of InvoiceNbr"], pivotData["Sum of Total"]]);

    return result;
}

/**
 * Prepares raw data for Excel export by adding headers and formatting rows.
 * @param {Array} data - The raw data to be processed.
 * @param {string} reportType - The type of report ("AR" or "AP").
 * @returns {Array} - An array of arrays (AOA) representing the formatted data.
 */
function prepareRawData(data = [], reportType) {
    const aoaData = [];
    if (!data || data.length === 0) {
        const headers = reportType === "AR" ? ["SourceSystem", "ErrorMsg", "ErrorCategory", "FileNbr", "CustomerId", "Subsidiary", "InvoiceNbr", "InvoiceDate", "FinalizedBy", "HousebillNbr", "MasterBillNbr", "InvoiceType", "ControllingStn", "ChargeCd", "CurrCd", "Total", "PostedDate", "GcCode", "TaxCode", "UniqueRefNbr", "InternalRefNbr", "OrderRef", "EeInvoice", "Intercompany", "Id"] : ["SourceSystem", "ErrorMsg", "ErrorCategory", "FileNbr", "VendorId", "Subsidiary", "InvoiceNbr", "InvoiceDate", "FinalizedBy", "HousebillNbr", "MasterBillNbr", "InvoiceType", "ControllingStn", "Currency", "ChargeCd", "Total", "PostedDate", "GcCode", "TaxCode", "UniqueRefNbr", "InternalRefNbr", "Intercompany", "Id", "EpayStatus", "SystemId"];
        // Add headers to aoaData
        aoaData.push(headers);
        return aoaData;
    }

    const invoiceColumnHeaders = Object.keys(data[0]).map((key) => {
        const words = key.split("_");
        return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
    });

    invoiceColumnHeaders.splice(2, 0, "ErrorCategory");
    aoaData.push(invoiceColumnHeaders);

    data?.forEach((item) => {
        const row = Object.values(item);
        row.splice(2, 0, getErrorMessage(_.get(item, "error_msg", "")));
        aoaData.push(row);
    });
    return aoaData;
}

/**
 * Maps error messages to user-friendly error categories.
 * @param {string} errorMsg - The raw error message.
 * @returns {string} - The corresponding error category.
 */
function getErrorMessage(errorMsg) {
    if (errorMsg.includes("Vendor not found")) return "Vendor not found";
    if (errorMsg.includes("You have entered an Invalid Field Value")) return "Field value not found";
    if (errorMsg.includes("unique key")) return "Duplicate invoices";
    if (errorMsg.includes("custcol2")) return "Location Updates";
    if (errorMsg.includes("Please enter value(s) for: Currency")) return "Wrong currency";
    if (errorMsg.includes("Unable to make payload Subsidiary")) return "Business segment error";
    if (errorMsg.includes("No valid, open, tax period for date")) return "Tax period Error";
    return "Blanks (no sub)";
}

/**
 * Writes pivot table data to an Excel sheet.
 * @param {Object} workbook - The Excel workbook object.
 * @param {Array} data - The pivot table data in AOA format.
 * @param {string} [sheetName="Top 10 Error Messages"] - The name of the sheet.
 */
function writePivotDataToExcel(workbook, data, sheetName = "Top 10 Error Messages") {
    const worksheet = xlsx.utils.aoa_to_sheet(data);

    // Set column widths
    worksheet["!cols"] = [
        { wch: 40 }, // Row Labels
        { wch: 20 }, // Count of InvoiceNbr
        { wch: 20 }, // Sum of Total
    ];

    xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
}

/**
 * Generates success summary data for Excel export.
 * @param {Array} data - The success summary data.
 * @param {string} sourceSystem - The source system identifier.
 * @returns {Array} - An array of arrays (AOA) representing the success summary data.
 */
function getSuccessSummaryData(data, sourceSystem) {
    const aoaData = [["Source System", "Processed Date", "Success", "Total Invoice", "Amount"]];

    data.forEach((item) => {
        aoaData.push([sourceSystem, moment().format("YYYY-MM-DD"), item.invoice_type === "CM" ? "Credit Memos" : "Invoices", item["count(invoice_nbr)"], parseFloat(item["sum(total)"]).toFixed(2)]);
    });

    return aoaData;
}

/**
 * Writes success summary data to an Excel sheet.
 * @param {Object} workbook - The Excel workbook object.
 * @param {Array} data - The success summary data in AOA format.
 * @param {string} [sheetName="All Successful Summarization"] - The name of the sheet.
 */
function writeSuccessSummaryData(workbook, data, sheetName = "All Successful Summarization") {
    const worksheet = xlsx.utils.aoa_to_sheet(data);

    // Set column widths
    const colCount = data[0]?.length || 0;
    worksheet["!cols"] = Array(colCount).fill({ wch: 25 });

    // Set merges for headers
    worksheet["!merges"] = [
        { s: { c: 0, r: 1 }, e: { c: 0, r: 2 } },
        { s: { c: 1, r: 1 }, e: { c: 1, r: 2 } },
    ];

    xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
}

/**
 * Writes generic data to an Excel sheet.
 * @param {Object} workbook - The Excel workbook object.
 * @param {Array} data - The data in AOA format.
 * @param {string} [sheetName="Sheet1"] - The name of the sheet.
 */
function commonWriter(workbook, data, sheetName = "Sheet1") {
    const worksheet = xlsx.utils.aoa_to_sheet(data);

    // Set column widths
    const colCount = data[0]?.length || 0;
    worksheet["!cols"] = Array(colCount).fill({ wch: 25 });

    xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
}

/**
 * Retrieves the integration schedule for AP processes.
 * @returns {Array} - An array of arrays (AOA) representing the integration schedule.
 */
function getIntegrationSchedule() {
    const integrationSchedule = [
        ["Integration for AP runs on the following schedule:", ""],
        ["Frequency", "Daily"],
        ["Timings (starts)", "12:30 PM CST"],
        ["", "3:30 PM CST"],
        ["", "10:00 AM CST"],
        ["", ""],
        ["Process Flow", ""],
        ["Step 1", "TMS system Jobs pushes to AWS S3 bucket"],
        ["Step 2", "AWS ETL Jobs pushes the raw line item data to interface AP table"],
        ["Step 3", "Orchestration Function starts posting data from interface AP table to NS"],
        ["Step 4", "Errors are captured and consolidated into a report and share with NSAP team"],
    ];
    return integrationSchedule;
}

/**
 * Generates an array of arrays (AOA) representing raw data for a report, including column headers and data rows.
 *
 * @param {Array<Object>} [data=[]] - The input data array, where each object represents a row of data.
 * @param {string} reportType - The type of report, either "AP" (Accounts Payable) or another type (e.g., Accounts Receivable).
 * @returns {Array<Array<string|number|null>>} - A 2D array where the first row contains column headers and subsequent rows contain data.
 */
function getSuccessAOARawData(data = [], reportType) {
    const aoaData = [];
    if (!data || data.length === 0) {
        const invoiceColumnHeaders =
            reportType === "AP"
                ? ["Source System Id", "File Nbr", "Vendor Id", "Subsidiary", "Invoice Nbr", "Invoice Date", "Ref Nbr", "Housebill Nbr", "Master Bill Nbr", "Consol Nbr", "Business Segment", "Invoice Type", "Handling Stn", "Controlling Stn", "Charge Cd", "Charge Cd Desc", "Charge Cd Internal Id", "Currency", "Rate", "Total Sales", "Person Email", "Posted Date", "Finalizedby", "Processed", "Processed Date", "Vendor Internal Id", "Currency Internal Id", "Internal Id", "Invoice Vendor Num", "Finalized Date", "Bill To Nbr", "Line Type", "Gc Code", "Gc Name", "Tax Code", "Tax Code Internal Id", "Intercompany", "Intercompany Processed", "Intercompany Processed Date", "Unique Ref Nbr", "Pairing Available Flag", "Internal Ref Nbr", "Mode Name", "Service Level", "Load Create Date", "Load Update Date", "Actual Weight", "Chargeable Weight", "Miles", "Dest Zip", "Dest State", "Dest Country", "Bill To Custno", "Invoice Summary"]
                : ["Source System Id", "File Nbr", "Customer Id", "Subsidiary", "Invoice Nbr", "Invoice Date", "Ref Nbr", "Housebill Nbr", "Master Bill Nbr", "Consol Nbr", "Business Segment", "Invoice Type", "Handling Stn", "Controlling Stn", "Charge Cd", "Charge Cd Desc", "Charge Cd Internal Id", "Currency", "Rate", "Total Sales", "Person Email", "Posted Date", "Finalizedby", "Processed", "Processed Date", "Customer Internal Id", "Currency Internal Id", "Internal Id", "Invoice Customer Num", "Finalized Date", "Bill To Nbr", "Line Type", "Gc Code", "Gc Name", "Tax Code", "Tax Code Internal Id", "Intercompany", "Intercompany Processed", "Intercompany Processed Date", "Unique Ref Nbr", "Pairing Available Flag", "Internal Ref Nbr", "Mode Name", "Service Level", "Load Create Date", "Load Update Date", "Actual Weight", "Chargeable Weight", "Miles", "Dest Zip", "Dest State", "Dest Country", "Bill To Custno", "Invoice Summary"];
        aoaData.push(invoiceColumnHeaders);
        return aoaData;
    }

    const invoiceColumnHeaders = Object.keys(data[0]).map((key) => {
        const words = key.split("_");
        return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
    });

    aoaData.push(invoiceColumnHeaders);

    data.forEach((item) => {
        const row = Object.keys(data[0]).map((key) => item[key]);
        aoaData.push(row);
    });
    return aoaData;
}

/**
 * Retrieves a guide for resolving various error categories related to invoice processing.
 *
 * @function
 * @returns {Array<Array<string>>} A 2D array where each sub-array represents an error category
 * and its associated details. The structure of the array is as follows:
 * - Index 0: Header row with column names ["#", "Error Category", "Action Item", "Action Owner", "POC"].
 * - Subsequent rows: Details for each error category, including:
 *   - "#" (string): The error category number.
 *   - "Error Category" (string): The name of the error category.
 *   - "Action Item" (string): The steps required to resolve the error.
 *   - "Action Owner" (string): The team or process responsible for the action.
 *   - "POC" (string): The point of contact for the error category.
 */
function getErrorResolutionGuide() {
    const errorCategories = [
        ["#", "Error Category", "Action Item", "Action Owner", "POC"],
        ["1", "Unique Invoices", "AP team to identify if invoice is duplicate and what the disposition of the invoice needs to be\n1. Cancel it from integration\n2. Reprocess as a new invoice", "BCE team to add letter /A and push the invoices", "Sunil"],
        ["2", "Location Updates", "AP team to provide location to BCE team.", "BCE Team + Vendor onboarding process", "Sunil/Yuliana"],
        ["3", "Invalid Currency", "AP team to add currency to sub", "Vendor onboarding process", "Yuliana"],
        ["4", "New tax period for sub-3", "NS team to add the tax period for sub", "NS team", "Stefan"],
        ["5", "Vendor not found", "AP team to onboard the vendor ids into NS", "Vendor onboarding process", "Yuliana"],
        ["6", "Field value not found", "NS team to add the field values for vendor sub", "NS team to advice & Onboarding team if required reaches in.", "Stefan/Yuliana"],
        ["7", "Tax code issue", "Tax codes are wrong.", "BCE Team", "Sunil"],
    ];
    return errorCategories;
}

/**
 * Updates the report data in the database by marking records as "in progress" for report sending.
 *
 * @async
 * @function updateReportData
 * @param {string} sourceSystem - The source system identifier.
 * @param {string} type - The type of report, e.g., "AP", "AR", or other types.
 * @param {Array<Object>} data - An array of data objects containing at least an `id` property.
 * @returns {Promise<any>} A promise that resolves with the result of the database update query.
 * @throws {Error} Throws an error if the update process fails.
 */
async function updateReportData(sourceSystem, type, data) {
    try {
        const maxId = Math.max(...data.map((e) => e.id));
        let table = "";
        if (type === "AP") {
            table = `${dbname}interface_ap_api_logs`;
        } else if (type === "AR") {
            table = `${dbname}interface_ar_api_logs`;
        } else {
            table = `${dbname}interface_intercompany_api_logs`;
        }

        const maxIdQuery = `select max(id) as maxId from ${table} where source_system = '${sourceSystem}' and is_report_sent ='N'`;
        const [rows] = await connections.execute(maxIdQuery);
        maxId = rows[0].maxId;

        const query = `Update ${table} set 
                    is_report_sent ='P', 
                    report_sent_time = '${moment().format("YYYY-MM-DD H:m:s")}' 
                    where source_system = '${sourceSystem}' and is_report_sent ='N' and id <= ${maxId}`;
        console.info("query", query);
        return await executeQuery(connections, sourceSystem, query);
    } catch (error) {
        console.error("error:updateReportData", error);
        throw error;
    }
}
