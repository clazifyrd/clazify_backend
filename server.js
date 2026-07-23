require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Initialize Firebase Admin
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
  } catch (error) {
    console.error("Failed to initialize Firebase Admin:", error.message);
  }
} else {
  console.log("FIREBASE_SERVICE_ACCOUNT environment variable is not set. Push notifications will be logged only.");
}

// Helper: send push notification to a user
async function sendPushNotification(fcmToken, title, body, data = {}) {
  if (!admin.apps.length || !fcmToken) {
    console.log(`[Push Notification Mock] To: ${fcmToken || 'N/A'}, Title: ${title}, Body: ${body}`);
    return;
  }
  
  const message = {
    notification: { title, body },
    data: data,
    token: fcmToken
  };

  try {
    const response = await admin.messaging().send(message);
    console.log("FCM notification sent successfully:", response);
  } catch (error) {
    console.error("Error sending FCM notification:", error.message);
  }
}

// Endpoint: Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

// Endpoint: Register or Update User
app.post('/api/register', async (req, res) => {
  const { id, name, designation, email, teamId, role, fcmToken } = req.body;
  if (!id || !email) {
    return res.status(400).json({ error: 'Missing required parameters: id, email' });
  }

  try {
    const query = `
      INSERT INTO users (id, name, designation, email, team_id, role, fcm_token, last_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        designation = EXCLUDED.designation,
        team_id = EXCLUDED.team_id,
        role = EXCLUDED.role,
        fcm_token = EXCLUDED.fcm_token,
        last_active = CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const result = await pool.query(query, [id, name, designation, email, teamId, role, fcmToken]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error registering user' });
  }
});

// Endpoint: Get Team Members
app.get('/api/teams/:teamId/members', async (req, res) => {
  try {
    const query = 'SELECT id, name, designation, email, role, fcm_token FROM users WHERE team_id = $1 ORDER BY name ASC';
    const result = await pool.query(query, [req.params.teamId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error fetching team members' });
  }
});

// Endpoint: Assign Global Task & Notify
app.post('/api/tasks', async (req, res) => {
  const { id, content, assignedBy, assignedByName, assignedTo, assignedToName, dueDate } = req.body;
  if (!id || !content || !assignedBy || !assignedTo) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Insert into DB
    const insertQuery = `
      INSERT INTO tasks (id, content, assigned_by, assigned_by_name, assigned_to, assigned_to_name, due_date, is_completed)
      VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
      RETURNING *;
    `;
    const result = await pool.query(insertQuery, [id, content, assignedBy, assignedByName, assignedTo, assignedToName, dueDate]);
    
    // Fetch recipient's FCM token
    const tokenQuery = 'SELECT fcm_token FROM users WHERE id = $1';
    const recipientRes = await pool.query(tokenQuery, [assignedTo]);
    const fcmToken = recipientRes.rows[0]?.fcm_token;

    if (fcmToken) {
      await sendPushNotification(
        fcmToken,
        'New Task Assigned!',
        `${assignedByName} assigned you: "${content.substring(0, 40)}${content.length > 40 ? '...' : ''}"`,
        {
          type: 'TASK',
          serverId: id,
          content: content,
          assignedById: assignedBy,
          assignedByName: assignedByName
        }
      );
    }

    res.json({ success: true, task: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error assigning task' });
  }
});

// Endpoint: Create Team Event (Exam, Test, Leave)
app.post('/api/events', async (req, res) => {
  const { id, title, description, eventType, startTimestamp, endTimestamp, trainerId, trainerName, teamId } = req.body;
  if (!id || !title || !eventType || !trainerId) {
    return res.status(400).json({ error: 'Missing required event fields' });
  }

  try {
    const query = `
      INSERT INTO events (id, title, description, event_type, start_timestamp, end_timestamp, trainer_id, trainer_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;
    const result = await pool.query(query, [id, title, description, eventType, startTimestamp, endTimestamp, trainerId, trainerName]);

    // Send notifications to all other team members
    const teamUsersQuery = 'SELECT id, fcm_token FROM users WHERE team_id = $1 AND id != $2';
    const teamUsers = await pool.query(teamUsersQuery, [teamId, trainerId]);

    const notificationPayload = {
      type: 'EVENT',
      eventId: id,
      title: title,
      description: description || '',
      eventType: eventType,
      startTimestamp: startTimestamp.toString(),
      endTimestamp: endTimestamp.toString(),
      trainerId: trainerId,
      trainerName: trainerName
    };

    for (const member of teamUsers.rows) {
      if (member.fcm_token) {
        await sendPushNotification(
          member.fcm_token,
          `New Team Event: ${eventType}`,
          `${trainerName} scheduled: "${title}"`,
          notificationPayload
        );
      }
    }

    res.json({ success: true, event: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error creating event' });
  }
});

// Endpoint: Get Team Events
app.get('/api/teams/:teamId/events', async (req, res) => {
  try {
    // Get events created by users who are in this team
    const query = `
      SELECT e.* FROM events e
      INNER JOIN users u ON e.trainer_id = u.id
      WHERE u.team_id = $1
      ORDER BY e.start_timestamp ASC
    `;
    const result = await pool.query(query, [req.params.teamId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error fetching team events' });
  }
});

// Endpoint: Sync Syllabus execution progress
app.post('/api/execution/sync', async (req, res) => {
  const { userId, subjectName, lectureInterval, subTopicLabel, status } = req.body;
  if (!userId || !subjectName || !lectureInterval) {
    return res.status(400).json({ error: 'Missing required sync parameters' });
  }

  try {
    const query = `
      INSERT INTO syllabus_progress (user_id, subject_name, lecture_interval, sub_topic_label, status, updated_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, subject_name, lecture_interval) DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const result = await pool.query(query, [userId, subjectName, lectureInterval, subTopicLabel, status]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error syncing execution plan' });
  }
});

// Endpoint: Get Team Syllabus Coverage Matrix
app.get('/api/teams/:teamId/coverage/:subject', async (req, res) => {
  try {
    const query = `
      SELECT sp.*, u.name as trainer_name FROM syllabus_progress sp
      INNER JOIN users u ON sp.user_id = u.id
      WHERE u.team_id = $1 AND sp.subject_name = $2
      ORDER BY sp.lecture_interval ASC
    `;
    const result = await pool.query(query, [req.params.teamId, req.params.subject]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error fetching syllabus coverage matrix' });
  }
});

// Endpoint: Receive & Upsert Attendance payload from Google Apps Script
app.post('/api/attendance/update', async (req, res) => {
  const { records } = req.body;
  if (!records || !Array.isArray(records)) {
    return res.status(400).json({ error: 'Missing or invalid records array' });
  }

  try {
    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance_records (
          id SERIAL PRIMARY KEY,
          subject_code VARCHAR(50) NOT NULL,
          batch_section VARCHAR(50) NOT NULL,
          date VARCHAR(20) NOT NULL,
          lecture_time_slot VARCHAR(50),
          lecture1_attendance INT DEFAULT 0,
          lecture2_attendance INT DEFAULT 0,
          total_students INT DEFAULT 0,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(subject_code, batch_section, date)
      );
    `);

    let upsertedCount = 0;
    for (const item of records) {
      const { subjectCode, batchSection, date, lectureTimeSlot, lecture1Attendance, lecture2Attendance, totalStudents } = item;
      if (!subjectCode || !batchSection || !date) continue;

      const query = `
        INSERT INTO attendance_records 
          (subject_code, batch_section, date, lecture_time_slot, lecture1_attendance, lecture2_attendance, total_students, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        ON CONFLICT (subject_code, batch_section, date) DO UPDATE SET
          lecture_time_slot = EXCLUDED.lecture_time_slot,
          lecture1_attendance = EXCLUDED.lecture1_attendance,
          lecture2_attendance = EXCLUDED.lecture2_attendance,
          total_students = EXCLUDED.total_students,
          updated_at = CURRENT_TIMESTAMP;
      `;
      await pool.query(query, [
        subjectCode,
        batchSection,
        date,
        lectureTimeSlot || '',
        lecture1Attendance || 0,
        lecture2Attendance || 0,
        totalStudents || 0
      ]);
      upsertedCount++;
    }

    res.json({ success: true, count: upsertedCount });
  } catch (err) {
    console.error('Error upserting attendance records:', err);
    res.status(500).json({ error: 'Database error upserting attendance records' });
  }
});

// Endpoint: Get Attendance records for Android mobile app
app.get('/api/attendance', async (req, res) => {
  const { date, subject, section } = req.query;
  try {
    let query = 'SELECT subject_code, batch_section, date, lecture_time_slot, lecture1_attendance, lecture2_attendance, total_students FROM attendance_records WHERE 1=1';
    const params = [];

    if (date) {
      params.push(date);
      query += ` AND date = $${params.length}`;
    }
    if (subject) {
      params.push(subject);
      query += ` AND subject_code = $${params.length}`;
    }
    if (section) {
      params.push(section);
      query += ` AND batch_section = $${params.length}`;
    }

    query += ' ORDER BY date DESC, subject_code ASC';

    const result = await pool.query(query, params);
    
    // Map snake_case DB columns to camelCase JSON properties
    const mapped = result.rows.map(row => ({
      subjectCode: row.subject_code,
      batchSection: row.batch_section,
      date: row.date,
      lectureTimeSlot: row.lecture_time_slot,
      lecture1Attendance: row.lecture1_attendance,
      lecture2Attendance: row.lecture2_attendance,
      totalStudents: row.total_students
    }));

    res.json(mapped);
  } catch (err) {
    console.error('Error fetching attendance records:', err);
    res.status(500).json({ error: 'Database error fetching attendance' });
  }
});

// Start Server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
