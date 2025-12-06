const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');

// ==========================================
// CONFIGURATION FOR RENDER
// ==========================================
const PORT = process.env.PORT || 3000;  // Use environment PORT or default to 3000

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://gopinathm_db_user:bi1gSuo0zFTO4ebG@cluster0.siwdo6l.mongodb.net/phonepe_apis?retryWrites=true&w=majority';

// MongoDB Connect with options to avoid deprecation warnings
mongoose.connect(MONGO_URI, { 
    useNewUrlParser: true, 
    useUnifiedTopology: true 
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
    shortOrderId: String,
    posDeviceId: String,
    amount: Number,
    transactionId: String,
    createdAt: String,
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
// MERGED ROUTES (SOURCE + MAIN API)
// ==========================================

// REGISTER/GET CONFIG
app.post('/internal/config', async (req, res) => {
    const { mid, tid } = req.body;
    let config = await ConfigModel.findOne({ merchantId: mid, terminalId: tid });

    if (!config) {
        config = new ConfigModel({
            merchantId: mid,
            terminalId: tid,
            integrationMode: "CLOUD",
            integratedModeDisplayName: "Cloud Integration (DB)",
            integrationMappingType: "ONE_TO_ONE",
            timestamp: new Date().toISOString()
        });
        await config.save();
    }
    res.json(config);
});

// MAIN API → CONFIG
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

// SALE REQUEST
app.post('/internal/sale', async (req, res) => {
    const newSale = new SaleModel({
        ...req.body,
        transactionId: "TXN_" + Date.now(),
        createdAt: new Date().toISOString(),
        status: "SUCCESS"
    });

    await newSale.save();

    res.json({
        merchantId: newSale.merchantId,
        terminalId: newSale.terminalId,
        amount: newSale.amount,
        autoAccept: true,
        transactionId: newSale.transactionId,
        code: "00",
        message: "Sale Saved"
    });
});

app.post('/v1/sale-request', async (req, res) => {
    const newSale = new SaleModel({
        ...req.body,
        transactionId: "TXN_" + Date.now(),
        createdAt: new Date().toISOString(),
        status: "SUCCESS"
    });

    await newSale.save();
    res.json(newSale);
});

// DEPLOY DEVICE
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

// OTP SEND
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

// OTP VERIFY
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
