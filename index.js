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
// 1. REQUEST LOGGER (DEBUGGING)
// ==========================================
app.use((req, res, next) => {
    console.log(`➡️  ${req.method} ${req.url}`);
    next();
});

// ==========================================
// 2. HEALTH CHECK (REQUIRED FOR RAILWAY)
// ==========================================
app.get('/', (req, res) => {
    res.status(200).send('PhonePe Dummy API is Running 🚀');
});

// ==========================================
// 3. DATABASE CONNECTION
// ==========================================
const DB_URI = 'mongodb+srv://gopinathm_db_user:bi1gSuo0zFTO4ebG@cluster0.siwdo6l.mongodb.net/phonepe_apis?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(DB_URI, {
    dbName: 'phonepe_apis',
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ DB Connection Error:', err.message));

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

// UPDATED: UPSERT CONFIG (PREVENT DUPLICATES)
app.post('/internal/config', async (req, res) => {
    try {
        const { mid, tid, integrationMode, integratedModeDisplayName, integrationMappingType } = req.body;

        const updateData = {
            merchantId: mid,
            terminalId: tid,
            integrationMode: integrationMode || "STANDALONE",
            integratedModeDisplayName: integratedModeDisplayName || "STANDALONE",
            integrationMappingType: integrationMappingType || "ONE_TO_ONE",
            timestamp: new Date().toISOString()
        };

        // Find by MID + TID. Update if exists, Create if new.
        const config = await ConfigModel.findOneAndUpdate(
            { merchantId: mid, terminalId: tid }, // Filter
            { $set: updateData },                 // Update
            { new: true, upsert: true, setDefaultsOnInsert: true } // Options
        );

        res.json(config);
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
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
        console.log("🔹 Internal Sale:", req.body);
        const timestamp = Date.now();
        const updateData = {
            ...req.body,
            amount: req.body.amount ? Number(req.body.amount) : 0,
            transactionId: "TXN_" + timestamp,
            createdAt: new Date().toISOString(),
            creationTimestamp: timestamp,
            status: "PENDING"
        };

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
        console.error(e);
        res.status(500).json({ code: "FAILED", message: e.message });
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
        console.log("🔹 Internal Deploy Update:", req.body);
        
        // We use finding based on Terminal ID to ensure uniqueness
        const filter = { terminalId: req.body.terminalId };

        const updateDoc = {
            $set: {
                ...req.body, // Update Sim, AppId, Status, MerchantId
                status: req.body.status || "DEPLOYED"
            },
            // Only generate these if it is a NEW record. 
            // If updating, keep the old Workflow/App Number.
            $setOnInsert: {
                workflowId: "WF-" + Date.now(),
                applicationNumber: "APP-" + Math.floor(Math.random() * 1000)
            }
        };

        const result = await DeployModel.findOneAndUpdate(
            filter,
            updateDoc,
            { new: true, upsert: true } // Upsert = Update or Insert
        );

        res.json(result);
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

// 2. Dynamic Route (Device Trigger) - MUST BE LAST
app.post('/:terminalSNo/deploy', async (req, res) => {
    try {
        console.log(`🔹 Device Deploy Update: ${req.params.terminalSNo}`);
        
        // Force the Terminal ID from the URL to be the unique key
        const filter = { terminalId: req.params.terminalSNo };

        const updateDoc = {
            $set: {
                ...req.body,
                terminalId: req.params.terminalSNo, // Ensure TID matches URL
                status: req.body.status || "DEPLOYED"
            },
            $setOnInsert: {
                workflowId: req.body.workflowId || ("WF-" + Date.now()),
                applicationNumber: "APP-" + Math.floor(Math.random() * 1000)
            }
        };

        const result = await DeployModel.findOneAndUpdate(
            filter,
            updateDoc,
            { new: true, upsert: true }
        );

        res.json(result);
    } catch (e) {
        console.error("Deploy Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/internal/otp/send', async (req, res) => {
    try {
        const randomOtp = Math.floor(1000 + Math.random() * 9000).toString();
        const verif = new VerificationModel({ workflowId: req.body.workflowId, otp: randomOtp, isVerified: false });
        await verif.save();
        console.log(`🔹 OTP generated: ${randomOtp}`);
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

// ==========================================
// START SERVER (UPDATED FOR RAILWAY)
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on PORT ${PORT}`);
});