const express = require('express');
const cors = require('cors');
const { ImapFlow } = require('imapflow');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// ============ DATABASE SETUP ============
// Gunakan /tmp untuk Render (writeable directory)
const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/tempmail.db' : './tempmail.db';
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Tabel untuk menyimpan email yang terdaftar
    db.run(`
        CREATE TABLE IF NOT EXISTS mailboxes (
            email TEXT PRIMARY KEY,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Tabel untuk menyimpan pesan email
    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            email TEXT,
            from_addr TEXT,
            subject TEXT,
            body TEXT,
            received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_read BOOLEAN DEFAULT 0,
            is_spam BOOLEAN DEFAULT 0,
            FOREIGN KEY(email) REFERENCES mailboxes(email)
        )
    `);
    
    console.log('✅ Database initialized at:', dbPath);
});

// ============ KONFIGURASI ============
// Ambil dari environment variable Render
const GMAIL_EMAIL = process.env.GMAIL_EMAIL;
const GMAIL_PASSWORD = process.env.GMAIL_PASSWORD;
const DOMAIN = process.env.DOMAIN || 'blazesky.qzz.io';

// Daftar folder yang akan diperiksa di Gmail
const FOLDERS_TO_CHECK = [
    'INBOX',
    '[Gmail]/Spam',
    '[Gmail]/Bin',
    '[Gmail]/All Mail'
];

// Validasi konfigurasi Gmail
if (!GMAIL_EMAIL || !GMAIL_PASSWORD) {
    console.warn('⚠️ WARNING: GMAIL_EMAIL or GMAIL_PASSWORD not set!');
    console.warn('⚠️ Email receiving will not work until configured!');
}

const GMAIL_CONFIG = {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
        user: GMAIL_EMAIL || '',
        password: GMAIL_PASSWORD || ''
    },
    logger: false,
    tls: {
        rejectUnauthorized: false
    }
};

// ============ HELPER FUNCTIONS ============
function isValidEmail(email) {
    return email && email.endsWith(`@${DOMAIN}`);
}

function cleanText(text) {
    if (!text) return '';
    // Remove extra whitespace and limit length
    return text.replace(/\s+/g, ' ').trim().substring(0, 5000);
}

// ============ FUNGSI PENYIMPANAN EMAIL ============
async function saveEmail(to, from, subject, body, isSpam = false) {
    const emailAddress = to.toLowerCase();
    
    return new Promise((resolve, reject) => {
        // Cek apakah email terdaftar di sistem
        db.get('SELECT email FROM mailboxes WHERE email = ?', [emailAddress], (err, row) => {
            if (err) {
                console.error('Database error:', err);
                reject(err);
                return;
            }
            
            if (row) {
                const id = uuidv4();
                const cleanSubject = cleanText(subject) || '(No Subject)';
                const cleanBody = cleanText(body) || 'No content';
                const cleanFrom = cleanText(from) || 'Unknown';
                
                db.run(
                    `INSERT INTO messages (id, email, from_addr, subject, body, received_at, is_spam)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [id, emailAddress, cleanFrom, cleanSubject, cleanBody, new Date().toISOString(), isSpam ? 1 : 0],
                    (err) => {
                        if (err) {
                            console.error('Error saving email:', err);
                            reject(err);
                        } else {
                            console.log(`✅ Email saved for ${emailAddress} from ${cleanFrom} ${isSpam ? '(SPAM)' : ''}`);
                            resolve(true);
                        }
                    }
                );
            } else {
                // Email tidak terdaftar di sistem kita, abaikan
                resolve(false);
            }
        });
    });
}

// ============ FUNGSI MEMBACA EMAIL DARI GMAIL ============
async function processFolder(client, folderName, isSpam = false) {
    try {
        // Coba akses folder, jika gagal (folder tidak ada) lewati
        let lock;
        try {
            lock = await client.getMailboxLock(folderName);
        } catch (err) {
            if (err.message.includes('Mailbox doesn\'t exist')) {
                return;
            }
            throw err;
        }
        
        try {
            // Cari email yang belum dibaca dalam 10 menit terakhir
            const messages = await client.search({
                unseen: true,
                since: new Date(Date.now() - 10 * 60 * 1000)
            });
            
            if (messages.length > 0) {
                console.log(`📧 Found ${messages.length} new messages in ${folderName}`);
            }
            
            for (const messageId of messages) {
                try {
                    const fetchResult = await client.fetchOne(messageId, {
                        envelope: true,
                        source: true,
                        bodyStructure: true
                    });
                    
                    if (fetchResult?.envelope) {
                        const to = fetchResult.envelope.to || [];
                        const from = fetchResult.envelope.from?.[0]?.address || 'Unknown';
                        const subject = fetchResult.envelope.subject || '(No Subject)';
                        
                        // Extract email body
                        let body = '';
                        if (fetchResult.source) {
                            const source = fetchResult.source.toString();
                            
                            // Try to extract text/plain
                            const textMatch = source.match(/Content-Type: text\/plain;.*?\r\n\r\n([\s\S]*?)(?=\r\n--|$)/i);
                            if (textMatch) {
                                body = textMatch[1].substring(0, 10000);
                            }
                            
                            // If no text/plain, try text/html and strip tags
                            if (!body) {
                                const htmlMatch = source.match(/Content-Type: text\/html;.*?\r\n\r\n([\s\S]*?)(?=\r\n--|$)/i);
                                if (htmlMatch) {
                                    body = htmlMatch[1].replace(/<[^>]*>/g, ' ').substring(0, 10000);
                                }
                            }
                            
                            // If still no body, try to get from raw source
                            if (!body) {
                                const lines = source.split('\n');
                                let inBody = false;
                                for (const line of lines) {
                                    if (line.trim() === '') {
                                        inBody = true;
                                        continue;
                                    }
                                    if (inBody && !line.match(/^[A-Za-z-]+:/)) {
                                        body += line + '\n';
                                        if (body.length > 10000) break;
                                    }
                                }
                            }
                        }
                        
                        // Simpan untuk setiap recipient yang valid
                        for (const recipient of to) {
                            const emailAddr = recipient.address;
                            if (emailAddr && isValidEmail(emailAddr)) {
                                await saveEmail(emailAddr, from, subject, body, isSpam);
                            }
                        }
                        
                        // Tandai sebagai sudah dibaca di Gmail
                        try {
                            await client.setFlags(messageId, ['\\Seen']);
                        } catch (err) {
                            console.error('Error marking as read:', err.message);
                        }
                    }
                } catch (err) {
                    console.error(`Error processing message in ${folderName}:`, err.message);
                }
            }
        } finally {
            lock.release();
        }
    } catch (error) {
        if (!error.message.includes('Mailbox doesn\'t exist')) {
            console.error(`Error accessing folder ${folderName}:`, error.message);
        }
    }
}

// ============ CEK SEMUA FOLDER ============
async function checkAllFolders() {
    if (!GMAIL_EMAIL || !GMAIL_PASSWORD) {
        return;
    }
    
    console.log(`🔍 [${new Date().toLocaleTimeString()}] Checking emails...`);
    const client = new ImapFlow(GMAIL_CONFIG);
    
    try {
        await client.connect();
        console.log('✅ Connected to Gmail IMAP');
        
        // Proses setiap folder
        for (const folder of FOLDERS_TO_CHECK) {
            const isSpam = folder.includes('Spam');
            await processFolder(client, folder, isSpam);
        }
        
        await client.logout();
        console.log('✅ Email check completed');
    } catch (error) {
        console.error('❌ Error checking emails:', error.message);
    }
}

// ============ API ENDPOINTS ============

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        domain: DOMAIN,
        gmailConfigured: !!(GMAIL_EMAIL && GMAIL_PASSWORD)
    });
});

// Generate atau get email
app.post('/api/get-email', (req, res) => {
    const { email } = req.body;
    
    if (email && email.includes('@')) {
        // Cek apakah email sudah ada
        db.get('SELECT email FROM mailboxes WHERE email = ?', [email], (err, row) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            if (row) {
                return res.json({ email: email });
            } else {
                // Buat email baru
                db.run('INSERT INTO mailboxes (email) VALUES (?)', [email], (err2) => {
                    if (err2) {
                        return res.status(500).json({ error: err2.message });
                    }
                    res.json({ email: email });
                });
            }
        });
    } else {
        // Generate random email
        const randomStr = Math.random().toString(36).substring(2, 15);
        const newEmail = `${randomStr}@${DOMAIN}`;
        
        db.run('INSERT INTO mailboxes (email) VALUES (?)', [newEmail], (err) => {
            if (err && !err.message.includes('UNIQUE')) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ email: newEmail });
        });
    }
});

// Generate new random email
app.post('/api/generate', (req, res) => {
    const randomStr = Math.random().toString(36).substring(2, 15);
    const newEmail = `${randomStr}@${DOMAIN}`;
    
    db.run('INSERT INTO mailboxes (email) VALUES (?)', [newEmail], (err) => {
        if (err && !err.message.includes('UNIQUE')) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ email: newEmail });
    });
});

// Get inbox untuk email tertentu
app.get('/api/inbox/:email', (req, res) => {
    const { email } = req.params;
    const { includeSpam } = req.query;
    
    let query = 'SELECT * FROM messages WHERE email = ?';
    const params = [email];
    
    if (includeSpam === 'false') {
        query += ' AND is_spam = 0';
    }
    
    query += ' ORDER BY received_at DESC';
    
    db.all(query, params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ messages: rows || [] });
    });
});

// Mark message as read
app.put('/api/messages/:id/read', (req, res) => {
    const { id } = req.params;
    
    db.run('UPDATE messages SET is_read = 1 WHERE id = ?', [id], (err) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true });
    });
});

// Delete single message
app.delete('/api/messages/:id', (req, res) => {
    const { id } = req.params;
    
    db.run('DELETE FROM messages WHERE id = ?', [id], (err) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true });
    });
});

// Delete all messages for an email
app.delete('/api/inbox/:email', (req, res) => {
    const { email } = req.params;
    
    db.run('DELETE FROM messages WHERE email = ?', [email], (err) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true });
    });
});

// Get statistics
app.get('/api/stats/:email', (req, res) => {
    const { email } = req.params;
    
    db.get(
        `SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN is_spam = 1 THEN 1 ELSE 0 END) as spam_count,
            SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread_count
         FROM messages WHERE email = ?`,
        [email],
        (err, row) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ 
                total: row?.total || 0,
                spam: row?.spam_count || 0,
                unread: row?.unread_count || 0
            });
        }
    );
});

// ============ PERIODIC EMAIL CHECK ============
// Cek email setiap 20 detik
let checkInterval = null;

function startEmailChecker() {
    if (checkInterval) clearInterval(checkInterval);
    
    if (GMAIL_EMAIL && GMAIL_PASSWORD) {
        checkInterval = setInterval(() => {
            checkAllFolders().catch(console.error);
        }, 20000);
        console.log('🚀 Email checker started (interval: 20 seconds)');
        
        // Langsung cek saat startup
        setTimeout(() => checkAllFolders().catch(console.error), 5000);
    } else {
        console.log('⚠️ Email checker not started: Gmail credentials missing');
    }
}

// ============ CLEANUP OLD EMAILS ============
// Hapus email yang sudah lebih dari 24 jam setiap jam
setInterval(() => {
    db.run("DELETE FROM messages WHERE received_at < datetime('now', '-1 day')", (err) => {
        if (err) {
            console.error('Cleanup error:', err);
        } else {
            console.log('🧹 Cleaned up old messages (>24 hours)');
        }
    });
    
    // Hapus mailbox yang kosong dan sudah lebih dari 24 jam
    db.run(`
        DELETE FROM mailboxes 
        WHERE created_at < datetime('now', '-1 day') 
        AND email NOT IN (SELECT DISTINCT email FROM messages)
    `, (err) => {
        if (err) {
            console.error('Mailbox cleanup error:', err);
        }
    });
}, 3600000); // Setiap jam

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                    🚀 TEMPMAIL BACKEND                   ║
╠══════════════════════════════════════════════════════════╣
║  Server running on port: ${PORT}                           
║  Domain: @${DOMAIN}                                        
║  Gmail configured: ${!!(GMAIL_EMAIL && GMAIL_PASSWORD)}                       
║  API URL: http://localhost:${PORT}/api                     
╚══════════════════════════════════════════════════════════╝
    `);
    
    startEmailChecker();
});

