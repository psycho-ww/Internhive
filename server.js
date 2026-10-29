const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs'); // 💡 UPGRADE: Built-in Node.js file handling module to remove files from storage
const db = require('./config/db');
const app = express();
// --- MIDDLEWARES & VIEW ENGINE CONFIG ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('views', [path.join(__dirname, 'view'), path.join(__dirname, 'views')]);
app.set('view engine', 'ejs');
app.use(session({
    secret: 'secret-key',
    resave: false,
    saveUninitialized: true
}));
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});
// 💡 ဖြည့်စွက်ချက် - Login အတင်းဝင်ခိုင်းရန် (Force Action) အတွက် ဖန်တီးထားသော Middleware
const requireLogin = (req, res, next) => {
    if (!req.session.user) {
        return res.send('<script>alert("Please login first to view profiles or apply for jobs!"); window.location="/login";</script>');
    }
    next();
};
// ========================================================
// 💡 UPGRADE: AUTOMATIC STORAGE CLEANUP HELPER FUNCTION
// ========================================================
/**
 * Safely removes a file from public/uploads/ if it exists.
 * Prevents server space accumulation on updates and deletions.
 */
const deletePhysicalFile = (filename) => {
    if (!filename) return;
    const filePath = path.join(__dirname, 'public', 'uploads', filename);
    if (fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
            if (err) console.error(`[Error] Failed to physically delete ${filename}:`, err);
            else console.log(`[Success] Physically deleted asset: ${filename}`);
        });
    }
};
// --- MULTER STORAGE CONFIG (FIXED: Identifiers ပေါင်းစည်းပြီး PDF Validation တစ်ခုတည်း ချန်လှပ်ထားသည်) ---
const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'cv_file') {
            if (path.extname(file.originalname).toLowerCase() === '.pdf') {
                cb(null, true);
            } else {
                cb(new Error('Only PDF files are allowed for CV!'), false);
            }
        } else {
            cb(null, true);
        }
    }
});
// ==========================================
//                 ROUTES
// ==========================================
// ၁။ PUBLIC LANDING PAGE
app.get('/', (req, res) => {
    res.render('index');
});
app.get('/about_us', (req, res) => {
    res.render('about_us'); 
});
// ၂။ PROJECT HUB PAGE
app.get('/projects', async (req, res) => {
    try {
        const search = req.query.search || '';
        const userId = req.session.user ? req.session.user.id : null;
        if (search && userId) {
            try {
                await db.query('INSERT INTO search_histories (user_id, search_type, keyword) VALUES (?, "student_post", ?)', [userId, search]);
            } catch (e){}
        }
        let postsQuery = `
        SELECT student_posts.*, users.name, users.profile_pic,
        (SELECT COUNT(*) FROM favorites WHERE favorites.post_id = student_posts.id) as fav_count,
        CASE WHEN ? IS NOT NULL AND EXISTS (SELECT 1 FROM favorites WHERE favorites.post_id = student_posts.id AND favorites.user_id = ?) THEN 1 ELSE 0 END as is_fav
        FROM student_posts
        JOIN users ON student_posts.student_id = users.id
        WHERE student_posts.admin_status = 'approved' `;
        let params = [userId, userId];
        if (search) {
            postsQuery += ` AND (student_posts.title LIKE ? OR student_posts.content LIKE ? )`;
            params.push(`%${search}%`, `%${search}%`);
        }
        postsQuery += ` ORDER BY student_posts.created_at DESC`;
        const [posts] = await db.query(postsQuery, params);
        let history = [];
        if (userId) {
            try {
                [history] = await db.query(
                'SELECT keyword FROM search_histories WHERE user_id = ? AND search_type = "student_post" GROUP BY keyword ORDER BY MAX(searched_at) DESC LIMIT 5', [userId]
                );
            } catch(e) {}
        }
        res.render('landing', { posts, search, history });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading project hub");
    }
});
// ၃။ CLEAR HISTORY ROUTES
app.post('/search/clear', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    try {
        await db.query('DELETE FROM search_histories WHERE user_id = ? AND search_type = "student_post"', [req.session.user.id]);
        res.redirect('/projects');
    } catch (err) { res.status(500).send("Clear History Error"); }
});
app.post('/search/clear-explore', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    try {
        await db.query('DELETE FROM search_histories WHERE user_id = ? AND search_type = "job"', [req.session.user.id]);
        res.redirect('/explore');
    } catch (err) { res.status(500).send("Clear Explore History Error"); }
});
// ၄။ PUBLIC PROFILE VISIT (💡 လုံခြုံရေးပြင်ဆင်ချက် - အခြား student များ CV မမြင်ရအောင် ပိတ်ထားမည်)
app.get('/user/profile/:id', requireLogin, async (req, res) => {
    try {
        const userId = req.params.id;
        const currentLoggedInUser = req.session.user; // လောလောဆယ် Login ဝင်ထားသူ
        
        const [targetUser] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        if (targetUser.length === 0) return res.status(404).send("User Not Found");
        
        // --- 🔒 CV Privacy Logic ---
        let canViewCV = false;
        if (currentLoggedInUser.id == userId) {
            
            canViewCV = true;
        } else if (currentLoggedInUser.role === 3) {
        
            canViewCV = true;
        } else if (currentLoggedInUser.role === 2) {
            // လာကြည့်သူက Company ဖြစ်ပါက ၎င်း Company ရဲ့ Job Vacancy တစ်ခုခုကို ဒီကျောင်းသားက လျှောက်ထားခြင်း ရှိ/မရှိ စစ်ဆေးသည်
            const [hasApplied] = await db.query(`
                SELECT 1 FROM applications 
                JOIN jobs ON applications.job_id = jobs.id 
                WHERE applications.student_id = ? AND jobs.company_id = ? LIMIT 1
            `, [userId, currentLoggedInUser.id]);
            
            if (hasApplied.length > 0) canViewCV = true; // အလုပ်လျှောက်ထားဖူးသော Company ဖြစ်က ကြည့်နိုင်သည်
        }
        // အခြား Student များ (role === 1 ဖြစ်ပြီး မိမိမဟုတ်သူများ) သည် အလိုအလျောက် canViewCV = false ဖြစ်နေမည်
        let userPosts = [];
        if (targetUser[0].role === 1) {
            [userPosts] = await db.query('SELECT * FROM student_posts WHERE student_id = ? AND admin_status = "approved" ORDER BY created_at DESC', [userId]);
        } else if (targetUser[0].role === 2) {
            [userPosts] = await db.query('SELECT * FROM jobs WHERE company_id = ? AND status = "approved" ORDER BY created_at DESC', [userId]);
        }
        
        res.render('public-profile', { 
            targetUser: targetUser[0], 
            posts: userPosts,
            canViewCV: canViewCV // View ထဲကို သယ်သွားပေးသည်
        });
    } catch (err) { res.status(500).send("Error fetching profile"); }
});
// ၅။ MY PROFILE PAGE
app.get('/profile', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    try {
        const userId = req.session.user.id;
        const [userData] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        const currentUser = userData[0];
        let notifications = [];
        let myPosts = [];
        if (currentUser.role === 1) {
            [notifications] = await db.query(`
            SELECT applications.*, users.name as company_name, jobs.title as job_title
            FROM applications
            JOIN jobs ON applications.job_id = jobs.id
            JOIN users ON jobs.company_id = users.id
            WHERE applications.student_id = ? AND applications.status != 'pending'
            ORDER BY applications.applied_at DESC`, [userId]);
            // 💡 ပြင်ဆင်ချက် - Admin က approved လုပ်ပြီးသား ပို့စ်များသာ တင်ထားသူ၏ Profile timeline တွင်ပြသမည်
            [myPosts] = await db.query('SELECT * FROM student_posts WHERE student_id = ? AND admin_status = "approved" ORDER BY created_at DESC', [userId]);
        } else if (currentUser.role === 2) {
            // 💡 ပြင်ဆင်ချက် - Admin က approved လုပ်ပြီးသား အလုပ်ခေါ်စာများသာ ကုမ္ပဏီ၏ Profile timeline တွင်ပြသမည်
            [myPosts] = await db.query('SELECT * FROM jobs WHERE company_id = ? AND status = "approved" ORDER BY created_at DESC', [userId]);
        }
        const [adminReplies] = await db.query('SELECT * FROM messages WHERE sender_id = ? ORDER BY created_at DESC', [userId]);
        res.render('profile', { user: currentUser, profileUser: currentUser, notifications, adminReplies, myPosts });
    } catch (err) { res.status(500).send("Profile Error"); }
});
// ၅။၁။ PROFILE & PIC UPDATE (💡 CV File ရောပါ လက်ခံပြီး Update လုပ်ပေးရန် ပြင်ဆင်ခြင်း)
app.post('/profile/update', upload.fields([
    { name: 'profile_pic', maxCount: 1 }, 
    { name: 'cover_pic', maxCount: 1 },
    { name: 'cv_file', maxCount: 1 } // CV field အသစ်ထည့်သွင်းခြင်း
]), async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { name, email, location, uni, major, year, industry, company_size, ownership_type, website_url } = req.body;
    const userId = req.session.user.id;
    try {
        const [current] = await db.query('SELECT profile_pic, cover_pic, cv_file FROM users WHERE id = ?', [userId]);
        let profilePic = current[0].profile_pic;
        let coverPic = current[0].cover_pic;
        let cvFile = current[0].cv_file; // မူရင်းဒေတာကို ယူထားမည်
        
        // 💡 UPGRADE: ပုံအသစ်/ဖိုင်အသစ် တက်လာပါက ပုံဟောင်း/ဖိုင်ဟောင်းကို storage ထဲမှ တိုက်ရိုက်ရှင်းထုတ်သည်
        if (req.files && req.files['profile_pic']) {
            if(current[0].profile_pic) deletePhysicalFile(current[0].profile_pic);
            profilePic = req.files['profile_pic'][0].filename;
        }
        if (req.files && req.files['cover_pic']) {
            if(current[0].cover_pic) deletePhysicalFile(current[0].cover_pic);
            coverPic = req.files['cover_pic'][0].filename;
        }
        if (req.files && req.files['cv_file']) {
            if(current[0].cv_file) deletePhysicalFile(current[0].cv_file);
            cvFile = req.files['cv_file'][0].filename; // ဖိုင်အသစ်တက်လာမှ အစားထိုးမည်
        }
        
        await db.query(`UPDATE users SET name=?, email=?, location=?, profile_pic=?, cover_pic=?, cv_file=?, uni=?, major=?, year=?, industry=?, company_size=?, ownership_type=?, website_url=? WHERE id=?`,
        [name, email, location, profilePic, coverPic, cvFile, uni||null, major||null, year||null, industry||null, company_size||null, ownership_type||null, website_url||null, userId]);
        
        const [updatedUser] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        req.session.user = updatedUser[0];
        res.send('<script>alert("Saved successfully!"); window.location="/profile";</script>');
    } catch (e) { 
        console.error(e);
        res.status(500).send("Update Failed: " + e.message); 
    }
});
// --- STUDENT POST MANAGEMENT ---
app.post('/post/create', upload.single('post_img'), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 1) return res.redirect('/login');
    try {
        const { title, content } = req.body;
        const img_url = req.file ? req.file.filename : null;
        await db.query('INSERT INTO student_posts (student_id, title, content, image_url, admin_status) VALUES (?, ?, ?, ?, "pending")',
        [req.session.user.id, title, content, img_url]);
        res.send('<script>alert("Submitted! Waiting for Admin verification."); window.location="/profile";</script>');
    } catch (err) { res.status(500).send("Submission Failed"); }
});
app.get('/post/edit/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 1) return res.redirect('/login');
    try {
        const [post] = await db.query('SELECT * FROM student_posts WHERE id = ? AND student_id = ?', [req.params.id, req.session.user.id]);
        if (post.length === 0) return res.send("Unauthorized");
        res.render('edit-post', { post: post[0] });
    } catch (err) { res.status(500).send("Server Error"); }
});
app.post('/post/update/:id', upload.single('post_img'), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 1) return res.redirect('/login');
    try {
        const { title, content } = req.body;
        const [post] = await db.query('SELECT * FROM student_posts WHERE id = ? AND student_id = ?', [req.params.id, req.session.user.id]);
        if (post.length === 0) return res.send("Unauthorized");
        let img_url = post[0].image_url;
        
        if (req.file) {
            // 💡 UPGRADE: Post ပုံအသစ်ပြောင်းပါက ပုံဟောင်းကို storage ထဲမှ ရှင်းလင်းသည်
            if(post[0].image_url) deletePhysicalFile(post[0].image_url);
            img_url = req.file.filename;
        }
        await db.query('UPDATE student_posts SET title = ?, content = ?, image_url = ?, admin_status = "pending" WHERE id = ?', [title, content, img_url, req.params.id]);
        res.send('<script>alert("Post updated and resent for approval!"); window.location="/profile";</script>');
    } catch (err) { res.status(500).send("Update Failed"); }
});
app.post('/post/delete/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 1) return res.redirect('/login');
    try {
        // 💡 UPGRADE: ဓာတ်ပုံဖိုင်အမည်အား Database မှ အရင်ရှာထုတ်ယူခြင်း
        const [post] = await db.query('SELECT image_url FROM student_posts WHERE id = ? AND student_id = ?', [req.params.id, req.session.user.id]);
        if (post.length > 0 && post[0].image_url) {
            deletePhysicalFile(post[0].image_url); // Storage ပေါ်မှ ဖျက်ဆီးပစ်ရန် ခေါ်ယူခြင်း
        }
        
        await db.query('DELETE FROM student_posts WHERE id = ? AND student_id = ?', [req.params.id, req.session.user.id]);
        res.redirect('/profile');
    } catch (err) { res.status(500).send("Delete Failed"); }
});
// ၆။ REGISTER & ၇။ LOGIN SYSTEM
app.get('/register', (req, res) => res.render('register'));
app.post('/register', async (req, res) => {
    try {
        const { name, email, password, role, location, major, uni, year, industry, company_size, ownership_type, website_url } = req.body;
        await db.query(`INSERT INTO users (name, email, password, role, location, major, uni, year, industry, company_size, ownership_type, website_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, email, password, role, location, major||null, uni||null, year||null, industry||null, company_size||null, ownership_type||null, website_url||null]);
        res.send('<script>alert("Registration Successful!"); window.location="/login";</script>');
    } catch (err) { res.status(500).send("Registration Error"); }
});
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const [users] = await db.query('SELECT * FROM users WHERE email = ? AND password = ?', [email, password]);
        if (users.length > 0) {
            req.session.user = users[0];
            if (users[0].role === 3) return res.redirect('/admin');
            return res.redirect('/profile');
        } else { return res.render('login', { error: 'Wrong Credentials!' }); }
    } catch (err) { res.status(500).send("Login Error"); }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
app.post('/post/favorite/:id', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Please login first' });
    try {
        const userId = req.session.user.id; const postId = req.params.id;
        const [existing] = await db.query('SELECT * FROM favorites WHERE user_id = ? AND post_id = ?', [userId, postId]);
        if (existing.length > 0) {
            await db.query('DELETE FROM favorites WHERE user_id = ? AND post_id = ?', [userId, postId]);
            res.json({ status: 'unfavorited' });
        } else {
            await db.query('INSERT INTO favorites (user_id, post_id) VALUES (?, ?)', [userId, postId]);
            res.json({ status: 'favorited' });
        }
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});
// server.js ထဲက app.get('/student-dashboard', ...) နေရာတွင် အစားထိုးရန်
app.get('/student-dashboard', async (req, res) => { 
    if (!req.session.user) return res.redirect('/login'); 
    if (req.session.user.role !== 1) return res.redirect('/home'); 

    try {
        const userId = req.session.user.id;

        // ၁။ ကျောင်းသား လျှောက်ထားခဲ့သမျှသော အလုပ်လျှောက်လွှာများ
        const [appliedCompanies] = await db.query(`
            SELECT applications.*, users.name as company_name, users.location as company_location, jobs.title as job_title, jobs.id as job_id
            FROM applications
            JOIN jobs ON applications.job_id = jobs.id
            JOIN users ON jobs.company_id = users.id
            WHERE applications.student_id = ?
            ORDER BY applications.applied_at DESC
        `, [userId]);

        // ၂။ ကျောင်းသားထံသို့ Employer များထံမှ ရောက်ရှိလာသော updates အားလုံး (applied အဆင့်မှလွဲ၍ ကျန်အဆင့်များပြရန်)
        const [notifications] = await db.query(`
            SELECT applications.*, users.name as company_name, jobs.title as job_title
            FROM applications
            JOIN jobs ON applications.job_id = jobs.id
            JOIN users ON jobs.company_id = users.id
            WHERE applications.student_id = ? AND applications.status != 'applied'
            ORDER BY applications.applied_at DESC
        `, [userId]);

        // ၃။ Admin ဆီသို့ ပေးပို့ထားသော စာများနှင့် ပြန်လာသော Reply message များ
        const [adminMessages] = await db.query(`
            SELECT * FROM messages WHERE sender_id = ? ORDER BY created_at DESC
        `, [userId]);

        res.render('student-dashboard', { 
            user: req.session.user, 
            appliedCompanies, 
            notifications, 
            adminMessages 
        });
    } catch (err) { 
        console.error(err);
        res.status(500).send("Error loading Student Dashboard"); 
    }
});
// ၁၁။ EXPLORE JOB PIPELINE 
app.get('/explore', async (req, res) => {
    try {
        const search = req.query.search || '';
        const userId = req.session.user ? req.session.user.id : null;
        if (search && userId) {
            try { await db.query('INSERT INTO search_histories (user_id, search_type, keyword) VALUES (?, "job", ?)', [userId, search]); } catch(e){}
        }
        
        let jobQuery = `
            SELECT jobs.*, users.name as company_name, users.profile_pic,
            (SELECT status FROM applications WHERE applications.job_id = jobs.id AND applications.status = "hired" LIMIT 1) as job_hired_status
            FROM jobs
            JOIN users ON jobs.company_id = users.id
            WHERE jobs.status = "approved"`;
        let params = [];
        if (search) {
            jobQuery += ' AND (jobs.title LIKE ? OR jobs.description LIKE ? OR users.name LIKE ?)';
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        jobQuery += ' ORDER BY jobs.created_at DESC';
        const [jobs] = await db.query(jobQuery, params);
        let history = [];
        if (userId) {
            try { [history] = await db.query('SELECT keyword FROM search_histories WHERE user_id = ? AND search_type = "job" GROUP BY keyword ORDER BY MAX(searched_at) DESC LIMIT 5', [userId]);
            } catch(e){}
        }
        res.render('explore', { jobs, search, history });
    } catch (err) { res.status(500).send("Explore Jobs Error"); }
});
// ၁၂။ (💡 တိုးချဲ့ Route - FIXED: res.pdf အစား res.sendFile သို့ ပြောင်းလဲထားသည်)
app.get('/company/view-cv/:filename', requireLogin, (req, res) => {
    // ကုမ္ပဏီ သို့မဟုတ် သက်ဆိုင်ရာကျောင်းသားကိုယ်တိုင်မှလွဲ၍ အခြားသူများ တိုက်ရိုက် URL link ကို သိရုံဖြင့် ဝင်မကြည့်နိုင်ရန် စစ်ဆေးခြင်း
    if (req.session.user.role === 2 || req.session.user.cv_file === req.params.filename) {
        const file = path.join(__dirname, 'public', 'uploads', req.params.filename);
        res.sendFile(file); // PDF ဖိုင်အား Browser ပေါ်တွင် တိုက်ရိုက် View နိုင်ရန် sendFile အသုံးပြုထားပါသည်
    } else {
        res.status(403).send("Unauthorized Access to CV File.");
    }
});
// 💡 ပြင်ဆင်ချက် - requireLogin ထည့်သွင်းထားသဖြင့် Login မဝင်ဘဲ လာရောက်လျှောက်ပါက ခွင့်မပြုဘဲ Redirect လုပ်ပါမည်
// server.js ထဲက app.post('/job/apply/:id', ...) နေရာတွင် အစားထိုးရန်
app.post('/job/apply/:id', requireLogin, async (req, res) => {
    if (req.session.user.role !== 1) return res.send("Only students can apply for jobs");
    try {
        // status နေရာတွင် 'applied' ဟု ပြောင်းလဲသတ်မှတ်လိုက်သည်
        await db.query('INSERT INTO applications (job_id, student_id, status) VALUES (?, ?, "applied")', [req.params.id, req.session.user.id]);
        res.send('<script>alert("Application Submitted Successfully!"); window.location="/explore";</script>');
    } catch (err) { res.status(500).send("Apply Error"); }
});
app.get('/contact', (req, res) => { if (!req.session.user) return res.redirect('/login'); res.render('contact'); });
app.post('/contact-admin', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    try {
        const { message } = req.body;
        await db.query('INSERT INTO messages (sender_id, message) VALUES (?, ?)', [req.session.user.id, message]);
        res.send('<script>alert("Dispatched to Admin!"); window.location="/projects";</script>');
    } catch (err) { res.status(500).send("Failed"); }
});
// =========================================================================
// 💡 NEW PIPELINE ACTIONS: SHORTLIST & SCHEDULE INTERVIEW ROUTES
// =========================================================================

// ၁။ Company က Shortlist လုပ်သည့်အဆင့်
app.post('/company/application/:id/shortlist', requireLogin, async (req, res) => {
    if (req.session.user.role !== 2) return res.status(403).send("Unauthorized");
    try {
        await db.query('UPDATE applications SET status = "shortlisted" WHERE id = ?', [req.params.id]);
        res.send('<script>alert("Student has been Shortlisted!"); window.location="/company";</script>');
    } catch (err) { res.status(500).send("Shortlist Error"); }
});

// ၂။ Company က Interview Schedule ချိန်းသည့်အဆင့်
app.post('/company/application/:id/schedule', requireLogin, async (req, res) => {
    if (req.session.user.role !== 2) return res.status(403).send("Unauthorized");
    try {
        const { interview_date, interview_link } = req.body;
        await db.query(
            'UPDATE applications SET status = "scheduled", interview_date = ?, interview_link = ? WHERE id = ?', 
            [interview_date, interview_link, req.params.id]
        );
        res.send('<script>alert("Interview Scheduled Successfully!"); window.location="/company";</script>');
    } catch (err) { res.status(500).send("Schedule Error"); }
});

// ၃။ Final Decision: Accept (Hired) လုပ်သည့်အဆင့် (လက်ရှိ code အဟောင်းကို update လုပ်ရန်)
app.post('/company/application/:id/accept', requireLogin, async (req, res) => {
    if (req.session.user.role !== 2) return res.status(403).send("Unauthorized");
    try {
        const { company_message } = req.body;
        await db.query('UPDATE applications SET status = "hired", company_message = ? WHERE id = ?', [company_message, req.params.id]);
        res.send('<script>alert("Application Accepted!"); window.location="/company";</script>');
    } catch (err) { res.status(500).send("Accept Error"); }
});


// ၄။ Final Decision: Reject လုပ်သည့်အဆင့် 
app.post('/company/application/:id/reject', requireLogin, async (req, res) => {
    if (req.session.user.role !== 2) return res.status(403).send("Unauthorized");
    try {
        await db.query('UPDATE applications SET status = "rejected" WHERE id = ?', [req.params.id]);
        res.send('<script>alert("Application Has Been Rejected."); window.location="/company";</script>');
    } catch (err) { res.status(500).send("Reject Error"); }
});

// ========================================================
//                    COMPANY FEATURES
// ========================================================
app.post('/company/job/create', upload.single('job_img'), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 2) return res.redirect('/login');
    try {
        const { title, description } = req.body;
        const img_url = req.file ? req.file.filename : null;
        await db.query('INSERT INTO jobs (company_id, title, description, image_url, status) VALUES (?, ?, ?, ?, "pending")',
        [req.session.user.id, title, description, img_url]);
        res.send('<script>alert("Vacancy submitted for Admin approval!"); window.location="/profile";</script>');
    } catch (err) { res.status(500).send("Failed"); }
});
app.get('/company/job/edit/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 2) return res.redirect('/login');
    try {
        const [job] = await db.query('SELECT * FROM jobs WHERE id = ? AND company_id = ?', [req.params.id, req.session.user.id]);
        res.render('edit-job', { job: job[0] });
    } catch (err) { res.status(500).send("Error"); }
});
app.post('/company/job/update/:id', upload.single('job_img'), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 2) return res.redirect('/login');
    try {
        const { title, description } = req.body;
        const [job] = await db.query('SELECT * FROM jobs WHERE id = ? AND company_id = ?', [req.params.id, req.session.user.id]);
        let img_url = job[0].image_url; 
        
        if (req.file) {
            // 💡 UPGRADE: Job Listing ပုံအသစ်ပြောင်းပါက ပုံဟောင်းကို storage ထဲမှ ဖျက်ဆီးသည်
            if(job[0].image_url) deletePhysicalFile(job[0].image_url);
            img_url = req.file.filename;
        }
        await db.query('UPDATE jobs SET title=?, description=?, image_url=?, status="pending" WHERE id=? AND company_id=?', [title, description, img_url, req.params.id, req.session.user.id]);
        res.send('<script>alert("Updated and waiting for re-approval!"); window.location="/profile";</script>');
    } catch (err) { res.status(500).send("Error"); }
});
app.post('/company/job/delete/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 2) return res.redirect('/login');
    try {
        // 💡 UPGRADE: Job ဓာတ်ပုံဖိုင်အမည်အား Database မှ အရင်ရှာထုတ်ယူခြင်း
        const [job] = await db.query('SELECT image_url FROM jobs WHERE id = ? AND company_id = ?', [req.params.id, req.session.user.id]);
        if (job.length > 0 && job[0].image_url) {
            deletePhysicalFile(job[0].image_url); // Storage ပေါ်မှ ဖျက်ဆီးပစ်ရန် ခေါ်ယူခြင်း
        }
        await db.query('DELETE FROM applications WHERE job_id = ?', [req.params.id]);
        await db.query('DELETE FROM jobs WHERE id = ? AND company_id = ?', [req.params.id, req.session.user.id]);
        res.redirect('/profile');
    } catch (err) { res.status(500).send("Delete Failed"); }
});
app.get('/company', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 2) return res.redirect('/login');
    try {
        // ✨ ပြင်ဆင်ချက်- users.cv_file ကိုပါ Query ထဲမှာ ထည့်သွင်းဆွဲထုတ်လိုက်ပါတယ်
        const [applications] = await db.query(`
            SELECT applications.*, users.name as student_name, users.uni, users.major, users.year, users.cv_file, jobs.title 
            FROM applications 
            JOIN jobs ON applications.job_id = jobs.id 
            JOIN users ON applications.student_id = users.id 
            WHERE jobs.company_id = ? 
            ORDER BY applications.applied_at DESC
        `, [req.session.user.id]);
        
        const [myJobs] = await db.query('SELECT * FROM jobs WHERE company_id = ? ORDER BY created_at DESC', [req.session.user.id]);
        res.render('company', { apps: applications, myJobs: myJobs });
    } catch (err) { res.status(500).send("Error"); }
});
// ========================================================
//                    ADMIN ROUTINES
// ========================================================
app.get('/admin', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 3) return res.redirect('/login');
    try {
        const [students] = await db.query('SELECT * FROM users WHERE role = 1 ORDER BY name ASC');
        const [companies] = await db.query('SELECT * FROM users WHERE role = 2 ORDER BY name ASC');
        const [[statsData]] = await db.query(`SELECT (SELECT COUNT(*) FROM users WHERE role = 1) as total_students, (SELECT COUNT(*) FROM users WHERE role = 2) as total_companies, (SELECT COUNT(*) FROM applications WHERE status = "hired") as placed`);
        const [successPlacements] = await db.query(`SELECT applications.applied_at, student.name as student_name, student.email as student_email, company.name as company_name, jobs.title as job_title FROM applications JOIN jobs ON applications.job_id = jobs.id JOIN users as student ON applications.student_id = student.id JOIN users as company ON jobs.company_id = company.id WHERE applications.status = 'hired' ORDER BY applications.applied_at DESC`);
        const [pendingJobs] = await db.query('SELECT jobs.*, users.name FROM jobs JOIN users ON jobs.company_id = users.id WHERE jobs.status = "pending"');
        const [pendingPosts] = await db.query('SELECT student_posts.*, users.name as student_name FROM student_posts JOIN users ON student_posts.student_id = users.id WHERE student_posts.admin_status = "pending"');
        
        // --- 💡 တိုးချဲ့ချက်- Active (Approved) ဖြစ်နေတဲ့ Post တွေရော Job (Vacancy) တွေကိုပါ ဆွဲထုတ်ပြီး Edit/Delete လုပ်ခွင့်ပေးရန် ---
        const [activePosts] = await db.query('SELECT student_posts.*, users.name as student_name FROM student_posts JOIN users ON student_posts.student_id = users.id WHERE student_posts.admin_status = "approved" ORDER BY student_posts.created_at DESC');
        const [activeJobs] = await db.query('SELECT jobs.*, users.name as company_name FROM jobs JOIN users ON jobs.company_id = users.id WHERE jobs.status = "approved" ORDER BY jobs.created_at DESC');
        
        const [messages] = await db.query('SELECT messages.*, users.name, users.email FROM messages JOIN users ON messages.sender_id = users.id ORDER BY messages.created_at DESC');
        
        res.render('admin', { pendingPosts, activePosts, activeJobs, messages, pendingJobs, students, companies, stats: statsData, successPlacements });
    } catch (err) { res.status(500).send("Admin Panel Error"); }
});
// --- User Management Actions ---
app.post('/admin/user/delete/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 3) return res.status(403).send("Unauthorized");
    try {
        const userId = req.params.id;
        
        // 💡 ၁။ အကောင့်မဖျက်မီ ၎င်းနှင့်ပတ်သက်သော Profile, Cover, CV (PDF) များကို ရှာဖွေပြီး Storage ထဲမှ ရှင်းလင်းသည်
        const [userFiles] = await db.query('SELECT profile_pic, cover_pic, cv_file FROM users WHERE id = ?', [userId]);
        if (userFiles.length > 0) {
            deletePhysicalFile(userFiles[0].profile_pic);
            deletePhysicalFile(userFiles[0].cover_pic);
            deletePhysicalFile(userFiles[0].cv_file);
        }
        // 💡 ၂။ ၎င်းကျောင်းသား တင်ခဲ့သမျှသော Posts ပုံများအားလုံးကို လိုက်ဖျက်ပေးသည်
        const [posts] = await db.query('SELECT image_url FROM student_posts WHERE student_id = ?', [userId]);
        posts.forEach(post => { if(post.image_url) deletePhysicalFile(post.image_url); });
        // 💡 ၃။ ၎င်းကုမ္ပဏီ တင်ခဲ့သမျှသော Jobs ပုံများအားလုံးကို လိုက်ဖျက်ပေးသည်
        const [jobs] = await db.query('SELECT image_url FROM jobs WHERE company_id = ?', [userId]);
        jobs.forEach(job => { if(job.image_url) deletePhysicalFile(job.image_url); });
        // =================================================================
        // 💡 FIXED ORDER OF DELETION: ဒေတာ ချိတ်ဆက်မှု စည်းကမ်းအတိုင်း အစီအစဉ်တကျဖျက်ခြင်း
        // =================================================================
        
        // (က) အကယ်၍ ဖျက်မယ့်သူက ကုမ္ပဏီဖြစ်ခဲ့ရင်... သူတင်ထားတဲ့ jobs တွေထဲကို လာလျှောက်ထားတဲ့ applications တွေကို အရင်ဆုံး ရှင်းရပါမယ်။
        await db.query('DELETE FROM applications WHERE job_id IN (SELECT id FROM jobs WHERE company_id = ?)', [userId]);
        // (ခ) အကယ်၍ ဖျက်မယ့်သူက ကျောင်းသားဖြစ်ခဲ့ရင်... သူကိုယ်တိုင် လျှောက်ထားခဲ့ဖူးတဲ့ applications တွေကို ရှင်းပါတယ်။
        await db.query('DELETE FROM applications WHERE student_id = ?', [userId]);
        // (ဂ) အပေါ်က လျှောက်လွှာ (Child rows) တွေ အားလုံးရှင်းပြီးမှ အလုပ်ခေါ်စာ (Parent rows) ကို စိတ်ချလက်ချ ဖျက်လို့ရပါပြီ။
        await db.query('DELETE FROM jobs WHERE company_id = ?', [userId]);
        // (ဃ) ကျန်တဲ့ ကျန်ရှိနေသေးသော ဒေတာများကို ဆက်လက်ဖျက်ဆီးခြင်း
        await db.query('DELETE FROM favorites WHERE user_id = ?', [userId]);
        await db.query('DELETE FROM student_posts WHERE student_id = ?', [userId]);
        await db.query('DELETE FROM search_histories WHERE user_id = ?', [userId]);
        await db.query('DELETE FROM messages WHERE sender_id = ?', [userId]);
        
        // (င) နောက်ဆုံးမှ အဓိက အကောင့် (Main User Row) ကို ဖျက်ပါတယ်
        await db.query('DELETE FROM users WHERE id = ?', [userId]);
        res.send('<script>alert("User Account completely removed!"); window.location="/admin";</script>');
    } catch (e) { 
        console.error(e);
        res.status(500).send("User Deletion Failed: " + e.message); 
    }
});
// --- Post & Job Status Actions ---
app.post('/admin/post/:id/approve', async (req, res) => {
    try { await db.query('UPDATE student_posts SET admin_status = "approved" WHERE id = ?', [req.params.id]); res.redirect('/admin'); } catch(e){ res.send("Error"); }
});
app.post('/admin/post/:id/reject', async (req, res) => {
    try { await db.query('UPDATE student_posts SET admin_status = "rejected" WHERE id = ?', [req.params.id]); res.redirect('/admin'); } catch(e){ res.send("Error"); }
});
app.post('/admin/post/:id/delete', async (req, res) => {
    try { 
        // 💡 UPGRADE: Admin က Post အား ဖြုတ်ချ/ဖျက်ဆီးချိန်တွင် ပုံပါပျက်အောင် လုပ်ဆောင်ခြင်း
        const [post] = await db.query('SELECT image_url FROM student_posts WHERE id = ?', [req.params.id]);
        if (post.length > 0 && post[0].image_url) {
            deletePhysicalFile(post[0].image_url);
        }
        await db.query('DELETE FROM student_posts WHERE id = ?', [req.params.id]); 
        res.redirect('/admin'); 
    } catch(e){ res.send("Error"); }
});
// Admin ကနေ Post ရဲ့ Content ကို တိုက်ရိုက် Edit လုပ်ပေးနိုင်ရန်
app.post('/admin/post/:id/edit', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 3) return res.status(403).send("Unauthorized");
    try {
        const { title, content } = req.body;
        await db.query('UPDATE student_posts SET title = ?, content = ? WHERE id = ?', [title, content, req.params.id]);
        res.send('<script>alert("Post successfully modified by Admin!"); window.location="/admin";</script>');
    } catch (e) { res.status(500).send("Error"); }
});
// ========================================================
// ✅ FIXED: ADMIN JOB EDIT ROUTE ကို အပေါ်သို့ ရွှေ့လိုက်သည် (Route Conflict မဖြစ်စေရန်)
// ========================================================
app.post('/admin/job/modify/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 3) return res.status(403).send("Unauthorized");
    try {
        const { title, description } = req.body;
        await db.query('UPDATE jobs SET title = ?, description = ? WHERE id = ?', [title, description, req.params.id]);
        res.send('<script>alert("Job listing successfully modified by Admin!"); window.location="/admin";</script>');
    } catch (e) { 
        console.error(e);
        res.status(500).send("Error"); 
    }
});

// Generic Route ဖြစ်တဲ့ ၎င်း Code အား အောက်တွင် ထားရမည်
app.post('/admin/job/:id/:action', async (req, res) => {
    try { 
        const status = req.params.action === 'approve' ? 'approved' : 'rejected';
        await db.query('UPDATE jobs SET status = ? WHERE id = ?', [status, req.params.id]); 
        res.redirect('/admin'); 
    } catch (err) { res.status(500).send("Admin Error"); }
});
app.post('/admin/job/:id/delete', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 3) return res.status(403).send("Unauthorized");
    try {
        // 💡 UPGRADE: Admin က Job Listing အား ဖျက်ဆီးချိန်တွင် ပုံပါပျက်အောင် လုပ်ဆောင်ခြင်း
        const [job] = await db.query('SELECT image_url FROM jobs WHERE id = ?', [req.params.id]);
        if (job.length > 0 && job[0].image_url) {
            deletePhysicalFile(job[0].image_url);
        }
        await db.query('DELETE FROM applications WHERE job_id = ?', [req.params.id]);
        await db.query('DELETE FROM jobs WHERE id = ?', [req.params.id]);
        res.redirect('/admin');
    } catch (err) { res.status(500).send("Delete Failed"); }
});
app.post('/admin/message/reply/:id', async (req, res) => {
    try { await db.query('UPDATE messages SET reply_message = ? WHERE id = ?', [req.body.reply_message, req.params.id]); res.redirect('/admin'); } catch(e){ res.send("Error"); }
});

// Multer Global Error Handler (PDF ဖိုင်မဟုတ်ပါက Error စနစ်တကျ ဖမ်းယူရန်)
app.use((err, req, res, next) => {
    if (err) {
        return res.send(`<script>alert("${err.message}"); window.history.back();</script>`);
    }
    next();
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running smoothly on port http://localhost:${PORT}`));
