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

// Start Server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
