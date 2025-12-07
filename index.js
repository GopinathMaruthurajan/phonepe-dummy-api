const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');

// ==========================================
// CONFIGURATION
// ==========================================
const PORT = process.env.PORT || 3000;

const app = express();
app.use(bodyParser.json());

// ==========================================
// 1. HEALTH CHECK ROUTE (CRITICAL FOR RAILWAY)
// ==========================================
// Railway pings this to ensure the app is alive. 
// Without this, Railway kills the app (SIGTERM).
app.get('/', (req, res) => {
    res.status(200).send('PhonePe Dummy API is Running 🚀');
});

app.get('/health', (req, res) => {
    const dbState = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected';
    res.status(200).json({ status: 'UP', db: dbState });
});

// ==========================================
// 2. ROBUST DATABASE CONNECTION
// ==========================================
const DB_URI = 'mongodb+srv://gopinathm_db_user:bi1gSuo0zFTO4ebG@cluster0.siwdo6l.mongodb.net/phonepe_apis?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(DB_URI, {
    dbName: 'phonepe_apis',
    serverSelectionTimeoutMS: 5000, // Fail fast if blocked
    socketTimeoutMS: 45000,
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ DB Connection Error:', err.message));

// Handle DB errors after initial connection
mongoose.connection.on('error', err => {
    console.error('❌ MongoDB Runtime Error:', err);
});

// ==========================================
// MONGODB SCHEMAS
// ==========================================
const ConfigSchema = new mongoose.Schema({ merchantId: String, terminalId: String, integrationMode: String, integratedModeDisplayName: String, integrationMappingType: String, timestamp: String });
const ConfigModel = mongoose.model('TerminalConfig', ConfigSchema);

const SaleSchema = new mongoose.Schema({
    merchantId: String, terminalId: String, posDeviceId: String, shortOrderId: String,
    amount: { type: Number, default: 0.0 },
    allowedInstruments: [String],
    autoAccept: { type: Boolean, default: true },
    autoAcceptWindowExpirySeconds: { type: Number, default: 0 },
    pregeneratedDQRTransactionId: String, pregeneratedCardTransactionId: String,
    transactionId: String, createdAt: String, creationTimestamp: Number, status: String, invoiceNumber: String
});
const SaleModel = mongoose.model('Sale', SaleSchema);

const DeploySchema = new mongoose.Schema({ simNo: String, merchantId: String, terminalId: String, appId: String, status: String, workflowId: String, applicationNumber: String });
const DeployModel = mongoose.model('Deployment', DeploySchema);

const VerificationSchema = new mongoose.Schema({ workflowId: String, appId: String, otp: String, isVerified: Boolean, simNo: String, latitude: String, longitude: String });
const VerificationModel = mongoose.model('Verification', VerificationSchema);

// ==========================================
// API ROUTES
// ==========================================

app.post('/internal/config', async (req, res) => {
    try {
        const { mid, tid, integrationMode, integratedModeDisplayName, integrationMappingType } = req.body;
        let config = await ConfigModel.findOne({ merchantId: mid, terminalId: tid });
        if (!config) {
            config = new ConfigModel({
                merchantId: mid, terminalId: tid,
                integrationMode: integrationMode || "STANDALONE",
                integratedModeDisplayName: integratedModeDisplayName || "STANDALONE",
                integrationMappingType: integrationMappingType || "ONE_TO_ONE",
                timestamp: new Date().toISOString()
            });
            await config.save();
        }
        res.json(config);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/v1/terminal/:mid/:tid/integrated-mode-config', async (req, res) => {
    try {
        const response = await ConfigModel.findOne({ merchantId: req.params.mid, terminalId: req.params.tid });
        res.json(response || {});
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/check-void', (req, res) => {
    const { mid, tid, invoiceNumber } = req.body;
    res.json({ merchantId: mid, terminalId: tid, allow: invoiceNumber !== "0000" });
});

app.get('/v1/terminal/:mid/:tid/allow-void', (req, res) => {
    res.json({ allow: req.query.invoiceNumber !== "0000" });
});

// --- SALE LOGIC ---

const createSaleResponse = (saleData) => ({
    code: "SUCCESS", message: "Sale Processed Successfully",
    merchantId: saleData.merchantId, terminalId: saleData.terminalId, posDeviceId: saleData.posDeviceId,
    shortOrderId: saleData.shortOrderId, amount: saleData.amount,
    allowedInstruments: saleData.allowedInstruments || [],
    autoAccept: saleData.autoAccept,
    autoAcceptWindowExpirySeconds: saleData.autoAcceptWindowExpirySeconds,
    pregeneratedDQRTransactionId: saleData.pregeneratedDQRTransactionId,
    pregeneratedCardTransactionId: saleData.pregeneratedCardTransactionId,
    transactionId: saleData.transactionId, creationTimestamp: saleData.creationTimestamp,
    createdAt: saleData.createdAt, data: saleData
});

app.post('/internal/sale', async (req, res) => {
    try {
        console.log("🔹 Internal Sale Update:", req.body);
        const timestamp = Date.now();
        const updateData = {
            ...req.body,
            amount: req.body.amount ? Number(req.body.amount) : 0,
            transactionId: "TXN_" + timestamp,
            createdAt: new Date().toISOString(),
            creationTimestamp: timestamp,
            status: "PENDING"
        };

        // Update if exists (Upsert), handles swapped IDs
        const sale = await SaleModel.findOneAndUpdate(
            {
                $or: [
                    { merchantId: req.body.merchantId, terminalId: req.body.terminalId },
                    { merchantId: req.body.terminalId, terminalId: req.body.merchantId }
                ],
                status: "PENDING"
            },
            { $set: updateData },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );
        res.json(createSaleResponse(sale.toObject()));
    } catch (e) {
        console.error("Sale Error:", e);
        res.status(500).json({ code: "FAILED", message: "DB Error: " + e.message });
    }
});

app.post('/v1/sale-request', async (req, res) => {
    try {
        const { merchantId, terminalId } = req.body;
        if (!merchantId || !terminalId) return res.status(400).json({ code: "FAILED", message: "IDs required" });

        const latestSale = await SaleModel.findOne({
            $or: [
                { merchantId: merchantId, terminalId: terminalId },
                { merchantId: terminalId, terminalId: merchantId }
            ]
        }).sort({ _id: -1 });

        if (!latestSale) return res.status(404).json({ code: "FAILED", message: "No sale found" });

        res.json(createSaleResponse(latestSale.toObject()));
    } catch (e) { res.status(500).json({ code: "FAILED", message: e.message }); }
});

// --- DEPLOY & OTP ---

app.post('/internal/deploy', async (req, res) => {
    try {
        const newDeploy = new DeployModel({
            ...req.body, status: "DEPLOYED",
            workflowId: "WF-" + Date.now(),
            applicationNumber: "APP-" + Math.floor(Math.random() * 1000)
        });
        await newDeploy.save();
        res.json(newDeploy);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/otp/send', async (req, res) => {
    try {
        const randomOtp = Math.floor(1000 + Math.random() * 9000).toString();
        const verif = new VerificationModel({ workflowId: req.body.workflowId, otp: randomOtp, isVerified: false });
        await verif.save();
        console.log(`🔹 OTP for ${req.body.workflowId}: ${randomOtp}`);
        res.json({ otpSent: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/verification/:workflowId/dispatch', async (req, res) => {
    try {
        const record = await VerificationModel.findOne({ workflowId: req.params.workflowId });
        if (record) res.json({ otp: record.otp, status: "SENT" });
        else res.status(404).json({ error: "Workflow Not Found" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/otp/verify', async (req, res) => {
    try {
        const record = await VerificationModel.findOne({ workflowId: req.body.workflowId });
        if (record) { record.isVerified = true; await record.save(); }
        res.json({ verified: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/verification/:workflowId/verify', async (req, res) => {
    res.json({ verified: true });
});

// Dynamic Route - MUST BE LAST
app.post('/:terminalSNo/deploy', async (req, res) => {
    try {
        console.log(`🔹 Deploy Request: ${req.params.terminalSNo}`);
        const newDeploy = new DeployModel({
            ...req.body,
            terminalId: req.params.terminalSNo,
            status: "DEPLOYED",
            workflowId: req.body.workflowId || ("WF-" + Date.now()),
            applicationNumber: "APP-" + Math.floor(Math.random() * 1000)
        });
        await newDeploy.save();
        res.json(newDeploy);
    } catch (e) {
        console.error("Deploy Error:", e);
        res.status(500).json({ error: "DB Error: " + e.message });
    }
});

// ==========================================
// PREVENT CRASHES ON UNHANDLED ERRORS
// ==========================================
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
    // Don't exit, just log it so Railway keeps running
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection:', reason);
    // Don't exit
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 Server running on PORT ${PORT}`);
});