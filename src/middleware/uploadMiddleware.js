const multer = require('multer');

/**
 * Upload middleware using multer with memory storage
 * 
 * MONOCODE Compliance:
 * - Observable Implementation: Clear logging and error handling
 * - Explicit Error Handling: Comprehensive file validation
 * - Dependency Transparency: Multer dependency clearly defined
 * - Progressive Construction: Simple, focused middleware
 */

// Configure multer to use memory storage (no disk writes)
const storage = multer.memoryStorage();

// File filter for image uploads
const fileFilter = (req, file, cb) => {
    console.log(`[UploadMiddleware] Processing file: ${file.originalname}, mimetype: ${file.mimetype}`);
    
    // Allow image files only
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        console.warn(`[UploadMiddleware] Rejected non-image file: ${file.originalname} (${file.mimetype})`);
        cb(new Error('Only image files are allowed'), false);
    }
};

// Configure multer with limits and validation
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
        files: 1 // Only allow single file upload
    }
});

// Single file upload middleware for 'image' field
const uploadSingle = upload.single('image');

// Enhanced middleware with error handling
const uploadMiddleware = (req, res, next) => {
    uploadSingle(req, res, (err) => {
        if (err) {
            console.error(`[UploadMiddleware] Upload error: ${err.message}`);
            
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(400).json({
                        message: 'File too large. Maximum size is 5MB.',
                        error: 'FILE_TOO_LARGE'
                    });
                }
                if (err.code === 'LIMIT_FILE_COUNT') {
                    return res.status(400).json({
                        message: 'Too many files. Only one image is allowed.',
                        error: 'TOO_MANY_FILES'
                    });
                }
                if (err.code === 'LIMIT_UNEXPECTED_FILE') {
                    return res.status(400).json({
                        message: 'Unexpected file field. Use "image" field name.',
                        error: 'UNEXPECTED_FILE_FIELD'
                    });
                }
            }
            
            return res.status(400).json({
                message: 'File upload error: ' + err.message,
                error: 'UPLOAD_ERROR'
            });
        }
        
        // Log successful upload
        if (req.file) {
            console.log(`[UploadMiddleware] ✅ File uploaded successfully: ${req.file.originalname} (${req.file.size} bytes)`);
            
            // MONOCODE Fix: Validate uploaded file has valid content
            if (!req.file.buffer || req.file.size === 0) {
                console.error(`[UploadMiddleware] Empty file detected: ${req.file.originalname} has ${req.file.size} bytes`);
                return res.status(400).json({
                    message: 'File upload failed: File appears to be empty. Please check the file and try again.',
                    error: 'EMPTY_FILE_UPLOAD',
                    details: {
                        fileName: req.file.originalname,
                        fileSize: req.file.size,
                        mimeType: req.file.mimetype
                    }
                });
            }
        }
        
        next();
    });
};

module.exports = uploadMiddleware; 