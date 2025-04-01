require('dotenv').config();
const express = require('express');
const AWS = require('aws-sdk');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // Để tạo ID duy nhất

require('aws-sdk/lib/maintenance_mode_message').suppress = true;

// --- AWS Configuration ---
AWS.config.update({
    accessKeyId: process.env.ACCESS_KEY_ID,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
    region: process.env.REGION,
});

const docClient = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const tableName = process.env.DYNAMODB_TABLE_NAME;
const bucketName = process.env.S3_BUCKET_NAME;

// --- Express App Setup ---
const app = express();
const PORT = process.env.PORT || 5000;

// --- Middleware ---
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Phục vụ file tĩnh nếu có (vd: CSS riêng)

// --- Multer Configuration (Lưu file vào bộ nhớ)---
const storage = multer.memoryStorage();
const imageFileFilter = (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|webp/; // Thêm webp nếu muốn
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (mimetype && extname) return cb(null, true);
    cb(new Error('Error: Allow Images Only (jpeg, jpg, png, gif, webp)!'), false);
};
const upload = multer({
    storage: storage,
    fileFilter: imageFileFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// --- View Engine Setup ---
app.set('view engine', 'ejs');
app.set('views', './views');

// --- Helper Function for S3 Upload ---
const uploadToS3 = async (file, productId) => {
    if (!file) return null; // Nếu không có file thì trả về null
    if (!bucketName) throw new Error("S3_BUCKET_NAME is not configured in .env");

    const fileExtension = path.extname(file.originalname).toLowerCase();
    // Đặt tên file theo cấu trúc products/productId/timestamp.ext
    const s3Key = `products/${productId}/${Date.now()}${fileExtension}`;

    const params = {
        Bucket: bucketName,
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ACL: 'public-read'
    };
    const s3Data = await s3.upload(params).promise();
    console.log(`File uploaded to S3: ${s3Data.Location}`);
    return s3Data.Location; // Trả về URL
};

// --- Helper Function for S3 Delete ---
const deleteFromS3 = async (imageURL) => {
    if (!imageURL || !bucketName) return; // Không có gì để xóa hoặc thiếu cấu hình bucket
    try {
        const url = new URL(imageURL);
        // Key là phần path sau domain (bỏ dấu / đầu tiên)
        const s3Key = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;

        if (s3Key) {
            const params = { Bucket: bucketName, Key: s3Key };
            console.log(`Attempting to delete from S3: ${s3Key}`);
            await s3.deleteObject(params).promise();
            console.log(`Successfully deleted from S3: ${s3Key}`);
        }
    } catch (err) {
        console.error(`Failed to delete '${imageURL}' from S3:`, err);
        // Không dừng ứng dụng, chỉ log lỗi
    }
};

// --- Routes ---

// READ All Products
app.get('/', async (req, res) => {
    const params = { TableName: tableName };
    try {
        const data = await docClient.scan(params).promise();
        res.render('index', { products: data.Items || [] });
    } catch (err) {
        console.error("Error fetching products:", err);
        res.status(500).send("Error fetching products.");
    }
});

// CREATE Product
app.post('/add', upload.single('productImage'), async (req, res) => {
    const { productName, description, price } = req.body;
    const imageFile = req.file;

    if (!productName || !description || !price) {
        return res.status(400).send("Missing required fields (name, description, price).");
    }
    // Tạo productId duy nhất
    const productId = uuidv4();

    try {
        const imageURL = await uploadToS3(imageFile, productId); // Upload ảnh trước

        const params = {
            TableName: tableName,
            Item: {
                productId: productId, // Sử dụng ID mới tạo
                productName: productName,
                description: description,
                price: Number(price), // Lưu giá dạng số
                imageURL: imageURL // Lưu URL từ S3 (có thể là null)
            }
        };
        await docClient.put(params).promise();
        console.log(`Product ${productId} added successfully.`);
        res.redirect('/');

    } catch (err) {
        console.error("Error adding product:", err);
        res.status(500).send(`Error adding product: ${err.message}`);
    }
});

// SHOW Update Form
app.get('/update/:productId', async (req, res) => {
    const { productId } = req.params;
    const params = { TableName: tableName, Key: { productId } };
    try {
        const data = await docClient.get(params).promise();
        if (!data.Item) return res.status(404).send("Product not found.");
        res.render('update', { product: data.Item });
    } catch (err) {
        console.error("Error fetching product for update:", err);
        res.status(500).send("Error fetching product details.");
    }
});

// UPDATE Product
app.post('/update/:productId', upload.single('productImage'), async (req, res) => {
    const { productId } = req.params;
    const { productName, description, price } = req.body;
    const newImageFile = req.file;

    try {
        // Lấy thông tin sản phẩm cũ (để lấy URL ảnh cũ nếu cần xóa)
        const getParams = { TableName: tableName, Key: { productId } };
        const oldData = await docClient.get(getParams).promise();
        if (!oldData.Item) return res.status(404).send("Product not found for update.");
        const oldImageURL = oldData.Item.imageURL;

        let newImageURL = oldImageURL; // Giữ URL cũ nếu không có ảnh mới
        let imageUpdated = false;

        // Nếu có ảnh mới được upload -> upload lên S3
        if (newImageFile) {
            newImageURL = await uploadToS3(newImageFile, productId);
            imageUpdated = true; // Đánh dấu là có ảnh mới
        }

        // --- Cập nhật DynamoDB ---
        // Chỉ cập nhật các trường được cung cấp (trừ productId)
        let updateExpression = 'SET ';
        const expressionAttributeValues = {};
        const expressionAttributeNames = {}; // Dùng nếu tên thuộc tính trùng keyword
        let updateParts = [];

        // Luôn cập nhật imageURL (dù là null, URL mới hay giữ URL cũ)
        updateParts.push('#img = :img');
        expressionAttributeValues[':img'] = newImageURL; // null nếu ko có ảnh hoặc ảnh mới
        expressionAttributeNames['#img'] = 'imageURL';


        // Chỉ cập nhật các trường khác nếu có giá trị mới
        if (productName) { updateParts.push('#pn = :pn'); expressionAttributeValues[':pn'] = productName; expressionAttributeNames['#pn'] = 'productName'; }
        if (description) { updateParts.push('#desc = :desc'); expressionAttributeValues[':desc'] = description; expressionAttributeNames['#desc'] = 'description'; }
        if (price) { updateParts.push('#pr = :pr'); expressionAttributeValues[':pr'] = Number(price); expressionAttributeNames['#pr'] = 'price'; }


        if (updateParts.length > 1 || imageUpdated) { // Chỉ update nếu có gì đó thay đổi
            updateExpression += updateParts.join(', ');
            const dynamoParams = {
                TableName: tableName,
                Key: { productId },
                UpdateExpression: updateExpression,
                ExpressionAttributeValues: expressionAttributeValues,
                ExpressionAttributeNames: expressionAttributeNames,
                ReturnValues: "UPDATED_NEW" // Optional
            };
            await docClient.update(dynamoParams).promise();
            console.log(`Product ${productId} updated successfully.`);

            // Nếu có ảnh mới và ảnh cũ -> Xóa ảnh cũ trên S3
            if (imageUpdated && oldImageURL && oldImageURL !== newImageURL) {
                await deleteFromS3(oldImageURL);
            }
        } else {
            console.log(`No changes detected for product ${productId}.`)
        }


        res.redirect('/');

    } catch (err) {
        console.error("Error updating product:", err);
        res.status(500).send(`Error updating product: ${err.message}`);
    }
});

// DELETE Product
app.post('/delete', async (req, res) => {
    const { productId } = req.body; // Lấy từ hidden input trong form
    if (!productId) return res.status(400).send("Product ID is required.");

    const params = {
        TableName: tableName,
        Key: { productId },
        ReturnValues: "ALL_OLD" // Lấy thông tin item TRƯỚC KHI xóa
    };

    try {
        const deletedData = await docClient.delete(params).promise();

        // Nếu item có tồn tại và có ảnh -> Xóa ảnh khỏi S3
        if (deletedData.Attributes && deletedData.Attributes.imageURL) {
            await deleteFromS3(deletedData.Attributes.imageURL);
        } else {
            console.log(`Product ${productId} deleted. No image found in S3 to delete or item did not exist.`);
        }
        console.log(`Product ${productId} deleted successfully from DynamoDB.`);
        res.redirect('/');

    } catch (err) {
        console.error("Error deleting product:", err);
        res.status(500).send(`Error deleting product: ${err.message}`);
    }
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
