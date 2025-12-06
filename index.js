const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');

// ==========================================
// CONFIGURATION FOR RENDER
// ==========================================
const PORT = process.env.PORT || 3000;

mongoose.connect('mongodb+srv://gopinathm_db_user:bi1gSuo0zFTO4ebG@cluster0.siwdo6l.mongodb.net/phonepe_apis?retryWrites=true&w=majority&appName=Cluster0', {
      dbName: 'phonepe_apis',
  })
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ DB Connection Error:', err));

const app = express();
app.use(bodyParser.json());

// ==========================================
// MONGODB SCHEMAS
// ==========================================
const ConfigSchema = new mongoose.Schema({
    merchantId: String,
    terminalId: String,
    integrationMode: String,
    integratedModeDisplayName: String,
    integrationMappingType: String,
    timestamp: String
});
const ConfigModel = mongoose.model('TerminalConfig', ConfigSchema);

const SaleSchema = new mongoose.Schema({
    merchantId: String,
    terminalId: String,
    posDeviceId: String,
    shortOrderId: String,
    amount: { type: Number, default: 0.0 }, // Default to 0.0 so it appears in JSON
    allowedInstruments: [String],
    autoAccept: { type: Boolean, default: true },
    autoAcceptWindowExpirySeconds: { type: Number, default: 0 }, // Added
    pregeneratedDQRTransactionId: String,  // Added
    pregeneratedCardTransactionId: String, // Added
    
    // Server Generated / Status fields
    transactionId: String,
    createdAt: String,
    creationTimestamp: Number,
    status: String,
    invoiceNumber: String
});
const SaleModel = mongoose.model('Sale', SaleSchema);

const DeploySchema = new mongoose.Schema({
    simNo: String,
    merchantId: String,
    terminalId: String,
    appId: String,
    status: String,
    workflowId: String,
    applicationNumber: String
});
const DeployModel = mongoose.model('Deployment', DeploySchema);

const VerificationSchema = new mongoose.Schema({
    workflowId: String,
    appId: String,
    otp: String,
    isVerified: Boolean,
    simNo: String,
    latitude: String,
    longitude: String
});
const VerificationModel = mongoose.model('Verification', VerificationSchema);

// ==========================================
// MERGED ROUTES
// ==========================================

// REGISTER/GET CONFIG
app.post('/internal/config', async (req, res) => {
    const { mid, tid, integrationMode, integratedModeDisplayName, integrationMappingType } = req.body;
    let config = await ConfigModel.findOne({ merchantId: mid, terminalId: tid });

    if (!config) {
        config = new ConfigModel({
            merchantId: mid,
            terminalId: tid,
            integrationMode: integrationMode || "STANDALONE",
            integratedModeDisplayName: integratedModeDisplayName || "STANDALONE",
            integrationMappingType: integrationMappingType || "ONE_TO_ONE",
            timestamp: new Date().toISOString()
        });
        await config.save();
    }
    res.json(config);
});

app.get('/v1/terminal/:mid/:tid/integrated-mode-config', async (req, res) => {
    const response = await ConfigModel.findOne({
        merchantId: req.params.mid,
        terminalId: req.params.tid
    });
    res.json(response || {});
});

// CHECK VOID
app.post('/internal/check-void', async (req, res) => {
    const { mid, tid, invoiceNumber } = req.body;
    const isAllowed = invoiceNumber !== "0000";
    res.json({ merchantId: mid, terminalId: tid, allow: isAllowed });
});

app.get('/v1/terminal/:mid/:tid/allow-void', async (req, res) => {
    res.json({ allow: req.query.invoiceNumber !== "0000" });
});

app.post('/internal/sale', async (req, res) => {
    try {
        console.log("🔹 Internal Sale: Saving Data...", req.body);

        const timestamp = Date.now();
        
        // Create and Save the Sale
        const newSale = new SaleModel({
            ...req.body,
            // Ensure amount is a number
            amount: req.body.amount ? Number(req.body.amount) : 0,
            transactionId: "TXN_" + timestamp,
            createdAt: new Date().toISOString(),
            creationTimestamp: timestamp,
            status: "PENDING" // Mark as pending so the terminal can pick it up
        });

        await newSale.save();
        
        // Return the saved data
        res.json(createSaleResponse(newSale.toObject()));
    } catch (e) {
        console.error(e);
        res.status(500).json({ code: "FAILED", message: e.message });
    }
});

// ==========================================
// 2. V1 SALE REQUEST - FETCHES THE DATA
// ==========================================
app.post('/v1/sale-request', async (req, res) => {
    try {
        console.log("🔸 V1 Sale Request: Fetching latest sale for...", req.body);

        // We need MerchantID and TerminalID to find the correct sale
        const { merchantId, terminalId } = req.body;

        if (!merchantId || !terminalId) {
            return res.status(400).json({ 
                code: "FAILED", 
                message: "merchantId and terminalId are required to fetch sale" 
            });
        }

        // FIND the latest sale for this terminal
        // Sort by _id: -1 (Descending) to get the newest one
        const latestSale = await SaleModel.findOne({ 
            merchantId: merchantId, 
            terminalId: terminalId 
        }).sort({ _id: -1 });

        if (!latestSale) {
            return res.status(404).json({ 
                code: "FAILED", 
                message: "No sale found for this terminal" 
            });
        }

        // Return the existing data from DB (which has amount 1.01)
        res.json(createSaleResponse(latestSale.toObject()));

    } catch (e) {
        console.error(e);
        res.status(500).json({ code: "FAILED", message: e.message });
    }
});

// Helper function remains the same
const createSaleResponse = (saleData) => {
    return {
        code: "SUCCESS",
        message: "Sale Fetch Successfully",
        merchantId: saleData.merchantId,
        terminalId: saleData.terminalId,
        posDeviceId: saleData.posDeviceId,
        shortOrderId: saleData.shortOrderId,
        amount: saleData.amount, 
        allowedInstruments: saleData.allowedInstruments || [],
        autoAccept: saleData.autoAccept,
        autoAcceptWindowExpirySeconds: saleData.autoAcceptWindowExpirySeconds,
        pregeneratedDQRTransactionId: saleData.pregeneratedDQRTransactionId,
        pregeneratedCardTransactionId: saleData.pregeneratedCardTransactionId,
        transactionId: saleData.transactionId,
        creationTimestamp: saleData.creationTimestamp,
        createdAt: saleData.createdAt,
        data: saleData
    };
};

// ==========================================
// DEPLOY & OTP
// ==========================================

app.post('/internal/deploy', async (req, res) => {
    const newDeploy = new DeployModel({
        ...req.body,
        status: "DEPLOYED",
        workflowId: "WF-" + Date.now(),
        applicationNumber: "APP-" + Math.floor(Math.random() * 1000)
    });
    await newDeploy.save();
    res.json(newDeploy);
});

app.post('/:terminalSNo/deploy', async (req, res) => {
    const newDeploy = new DeployModel({
        terminalId: req.params.terminalSNo,
        ...req.body,
        status: "DEPLOYED"
    });
    await newDeploy.save();
    res.json(newDeploy);
});

// OTP
app.post('/internal/otp/send', async (req, res) => {
    const verif = new VerificationModel({
        workflowId: req.body.workflowId,
        otp: "1234",
        isVerified: false
    });
    await verif.save();
    res.json({ otpSent: true });
});

app.post('/verification/:workflowId/dispatch', async (req, res) => {
    res.json({ otp: "1234", status: "SENT" });
});

app.post('/internal/otp/verify', async (req, res) => {
    const record = await VerificationModel.findOne({ workflowId: req.body.workflowId });
    if (record) {
        record.isVerified = true;
        await record.save();
    }
    res.json({ verified: true });
});

app.post('/verification/:workflowId/verify', async (req, res) => {
    res.json({ verified: true });
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 Server running on PORT ${PORT}`);
});