-- Database Schema for Clazify Teams Platform (PostgreSQL)

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    designation VARCHAR(100),
    email VARCHAR(100) UNIQUE NOT NULL,
    team_id VARCHAR(50),
    role VARCHAR(20) DEFAULT 'MEMBER', -- 'MEMBER', 'LEADER'
    fcm_token TEXT,
    last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Teams table
CREATE TABLE IF NOT EXISTS teams (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    subject VARCHAR(100),
    leader_id VARCHAR(100) REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id VARCHAR(100) PRIMARY KEY,
    content TEXT NOT NULL,
    assigned_by VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
    assigned_by_name VARCHAR(100),
    assigned_to VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
    assigned_to_name VARCHAR(100),
    due_date VARCHAR(50),
    is_completed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Events table
CREATE TABLE IF NOT EXISTS events (
    id VARCHAR(100) PRIMARY KEY,
    title VARCHAR(150) NOT NULL,
    description TEXT,
    event_type VARCHAR(20) NOT NULL, -- 'ST', 'EXAM', 'LEAVE'
    start_timestamp BIGINT NOT NULL,
    end_timestamp BIGINT NOT NULL,
    trainer_id VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
    trainer_name VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Syllabus Execution Topics Progress tracking
CREATE TABLE IF NOT EXISTS syllabus_progress (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
    subject_name VARCHAR(100) NOT NULL,
    lecture_interval VARCHAR(50) NOT NULL,
    sub_topic_label VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'Pending', -- 'Pending', 'In Progress', 'Completed'
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, subject_name, lecture_interval)
);
