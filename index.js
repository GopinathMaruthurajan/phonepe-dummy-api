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
    amount: { type: Number, default: 0.0 },
    allowedInstruments: [String],
    autoAccept: { type: Boolean, default: true },
    autoAcceptWindowExpirySeconds: { type: Number, default: 0 },
    pregeneratedDQRTransactionId: String,
    pregeneratedCardTransactionId: String,
    
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
    try {
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
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/v1/terminal/:mid/:tid/integrated-mode-config', async (req, res) => {
    try {
        const response = await ConfigModel.findOne({
            merchantId: req.params.mid,
            terminalId: req.params.tid
        });
        res.json(response || {});
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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

// ==========================================
// 1. INTERNAL API - SAVES/UPDATES DATA
// ==========================================
app.post('/internal/sale', async (req, res) => {
    try {
        console.log("------------------------------------------------");
        console.log("🔹 INTERNAL SALE: Received Data:", req.body);

        const timestamp = Date.now();
        
        // Prepare the Data
        const updateData = {
            ...req.body,
            amount: req.body.amount ? Number(req.body.amount) : 0,
            transactionId: "TXN_" + timestamp, // Generate new TXN ID on update
            createdAt: new Date().toISOString(),
            creationTimestamp: timestamp,
            status: "PENDING"
        };

        // UPSERT OPERATION (Update if exists, Insert if new)
        // We match based on Terminal ID + Status PENDING
        // We use $or to handle the ID swap case just to be safe
        const sale = await SaleModel.findOneAndUpdate(
            {
                $or: [
                    { merchantId: req.body.merchantId, terminalId: req.body.terminalId },
                    { merchantId: req.body.terminalId, terminalId: req.body.merchantId }
                ],
                status: "PENDING" // Only update if it's still pending
            },
            { $set: updateData },
            { 
                new: true,   // Return the updated document
                upsert: true, // Create if it doesn't exist
                setDefaultsOnInsert: true 
            }
        );

        console.log("✅ Data Upserted (Updated/Created) ID:", sale._id);
        console.log("------------------------------------------------");
        
        res.json(createSaleResponse(sale.toObject()));
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
        console.log("------------------------------------------------");
        console.log("🔸 V1 REQUEST: Looking for sale...");
        const { merchantId, terminalId } = req.body;

        if (!merchantId || !terminalId) {
            return res.status(400).json({ code: "FAILED", message: "merchantId and terminalId required" });
        }

        const latestSale = await SaleModel.findOne({ 
            $or: [
                { merchantId: merchantId, terminalId: terminalId },
                { merchantId: terminalId, terminalId: merchantId }
            ]
        }).sort({ _id: -1 });

        if (!latestSale) {
            return res.status(404).json({ code: "FAILED", message: "No sale found for this terminal" });
        }

        console.log("✅ Found Sale:", latestSale._id, "| Amount:", latestSale.amount);
        res.json(createSaleResponse(latestSale.toObject()));

    } catch (e) {
        console.error(e);
        res.status(500).json({ code: "FAILED", message: e.message });
    }
});

// Helper Function
const createSaleResponse = (saleData) => {
    return {
        code: "SUCCESS",
        message: "Sale Processed Successfully",
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
// DEPLOY ROUTES (FIXED HANGING ISSUE)
// ==========================================

// 1. Static route must come BEFORE dynamic route
app.post('/internal/deploy', async (req, res) => {
    try {
        const newDeploy = new DeployModel({
            ...req.body,
            status: "DEPLOYED",
            workflowId: "WF-" + Date.now(),
            applicationNumber: "APP-" + Math.floor(Math.random() * 1000)
        });
        await newDeploy.save();
        res.json(newDeploy);
    } catch (e) {
        console.error("Deploy Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 2. Dynamic route (This was likely causing the hang if error occurred)
app.post('/:terminalSNo/deploy', async (req, res) => {
    try {
        console.log(`🔹 Deploy Request for Terminal: ${req.params.terminalSNo}`);
        
        const newDeploy = new DeployModel({
            // Merge params and body. Params take priority for terminalId
            ...req.body,
            terminalId: req.params.terminalSNo, 
            status: "DEPLOYED",
            // Generate workflow if not sent
            workflowId: req.body.workflowId || ("WF-" + Date.now()),
            applicationNumber: "APP-" + Math.floor(Math.random() * 1000)
        });

        await newDeploy.save();
        res.json(newDeploy);
    } catch (e) {
        console.error("Deploy Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// OTP ROUTES (FIXED HARDCODING)
// ==========================================

app.post('/internal/otp/send', async (req, res) => {
    try {
        // Generate a random 4-digit OTP
        const randomOtp = Math.floor(1000 + Math.random() * 9000).toString();
        
        const verif = new VerificationModel({
            workflowId: req.body.workflowId,
            otp: randomOtp,
            isVerified: false
        });
        await verif.save();
        
        // Return OTP in console for testing, but API says sent
        console.log(`🔹 OTP generated for ${req.body.workflowId}: ${randomOtp}`);
        res.json({ otpSent: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// This API now fetches the REAL OTP from DB
app.post('/verification/:workflowId/dispatch', async (req, res) => {
    try {
        const record = await VerificationModel.findOne({ workflowId: req.params.workflowId });
        
        if (record) {
            res.json({ otp: record.otp, status: "SENT" });
        } else {
            res.status(404).json({ error: "Workflow ID not found" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/internal/otp/verify', async (req, res) => {
    try {
        const record = await VerificationModel.findOne({ workflowId: req.body.workflowId });
        if (record) {
            record.isVerified = true;
            await record.save();
        }
        res.json({ verified: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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