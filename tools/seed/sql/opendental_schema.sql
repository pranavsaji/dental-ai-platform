-- Subset of the open-source OpenDental MySQL schema, used as the simulated
-- on-premise Practice Management System. Table and column names follow the
-- real OpenDental conventions (PascalCase, *Num primary keys) so the Edge
-- Synchronizer's queries would run unchanged against a genuine install.
--
-- Change tracking: OpenDental stamps rows via DateTStamp (TIMESTAMP ... ON
-- UPDATE CURRENT_TIMESTAMP) and, on newer tables, SecDateTEdit. The Edge
-- Synchronizer cursors on DateTStamp.

CREATE TABLE IF NOT EXISTS provider (
  ProvNum BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  Abbr VARCHAR(255) NOT NULL DEFAULT '',
  LName VARCHAR(100) NOT NULL DEFAULT '',
  FName VARCHAR(100) NOT NULL DEFAULT '',
  Specialty BIGINT NOT NULL DEFAULT 0,
  IsHidden TINYINT NOT NULL DEFAULT 0,
  DateTStamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_provider_stamp (DateTStamp)
);

CREATE TABLE IF NOT EXISTS operatory (
  OperatoryNum BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  OpName VARCHAR(255) NOT NULL DEFAULT '',
  Abbrev VARCHAR(255) NOT NULL DEFAULT '',
  ItemOrder INT NOT NULL DEFAULT 0,
  IsHidden TINYINT NOT NULL DEFAULT 0,
  ProvDentist BIGINT NOT NULL DEFAULT 0,
  DateTStamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_operatory_stamp (DateTStamp)
);

CREATE TABLE IF NOT EXISTS procedurecode (
  CodeNum BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ProcCode VARCHAR(15) NOT NULL DEFAULT '',
  Descript VARCHAR(255) NOT NULL DEFAULT '',
  AbbrDesc VARCHAR(50) NOT NULL DEFAULT '',
  ProcTime VARCHAR(24) NOT NULL DEFAULT '',
  DateTStamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY idx_proccode (ProcCode),
  KEY idx_procedurecode_stamp (DateTStamp)
);

CREATE TABLE IF NOT EXISTS patient (
  PatNum BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  LName VARCHAR(100) NOT NULL DEFAULT '',
  FName VARCHAR(100) NOT NULL DEFAULT '',
  Birthdate DATE NOT NULL DEFAULT '0001-01-01',
  Gender TINYINT NOT NULL DEFAULT 0,             -- 0 Male, 1 Female, 2 Unknown
  PatStatus TINYINT NOT NULL DEFAULT 0,          -- 0 Patient, 2 Inactive, 4 Archived
  HmPhone VARCHAR(30) NOT NULL DEFAULT '',
  WirelessPhone VARCHAR(30) NOT NULL DEFAULT '',
  Email VARCHAR(100) NOT NULL DEFAULT '',
  Address VARCHAR(100) NOT NULL DEFAULT '',
  City VARCHAR(100) NOT NULL DEFAULT '',
  State VARCHAR(100) NOT NULL DEFAULT '',
  Zip VARCHAR(100) NOT NULL DEFAULT '',
  PriProv BIGINT NOT NULL DEFAULT 0,
  TxtMsgOk TINYINT NOT NULL DEFAULT 0,           -- 0 Unknown, 1 Yes, 2 No
  SecDateEntry DATE NOT NULL DEFAULT '0001-01-01',
  SecDateTEdit TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  DateTStamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_patient_stamp (DateTStamp)
);

CREATE TABLE IF NOT EXISTS appointment (
  AptNum BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  PatNum BIGINT NOT NULL DEFAULT 0,
  AptStatus TINYINT NOT NULL DEFAULT 1,          -- 1 Scheduled, 2 Complete, 3 UnschedList, 5 Broken, 6 Planned
  Pattern VARCHAR(255) NOT NULL DEFAULT '//XX//',-- 5-min increments; X = provider time
  Confirmed BIGINT NOT NULL DEFAULT 0,
  Op BIGINT NOT NULL DEFAULT 0,                  -- operatory
  ProvNum BIGINT NOT NULL DEFAULT 0,
  AptDateTime DATETIME NOT NULL DEFAULT '0001-01-01 00:00:00',
  Note TEXT,
  ProcDescript VARCHAR(255) NOT NULL DEFAULT '',
  SecDateTEdit TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  DateTStamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_appointment_stamp (DateTStamp),
  KEY idx_appointment_pat (PatNum),
  KEY idx_appointment_date (AptDateTime)
);

CREATE TABLE IF NOT EXISTS procedurelog (
  ProcNum BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  PatNum BIGINT NOT NULL DEFAULT 0,
  AptNum BIGINT NOT NULL DEFAULT 0,
  ProcDate DATE NOT NULL DEFAULT '0001-01-01',
  ProcFee DOUBLE NOT NULL DEFAULT 0,
  ProcStatus TINYINT NOT NULL DEFAULT 1,         -- 1 TreatmentPlanned, 2 Complete, 6 Deleted
  ProvNum BIGINT NOT NULL DEFAULT 0,
  CodeNum BIGINT NOT NULL DEFAULT 0,
  ToothNum VARCHAR(10) NOT NULL DEFAULT '',
  Surf VARCHAR(10) NOT NULL DEFAULT '',
  DateTStamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_procedurelog_stamp (DateTStamp),
  KEY idx_procedurelog_pat (PatNum)
);

CREATE TABLE IF NOT EXISTS insplan (
  PlanNum BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  GroupName VARCHAR(50) NOT NULL DEFAULT '',
  GroupNum VARCHAR(25) NOT NULL DEFAULT '',
  CarrierName VARCHAR(255) NOT NULL DEFAULT '',  -- denormalized from carrier table for the sim
  PlanType VARCHAR(1) NOT NULL DEFAULT '',       -- '' Category %, 'p' PPO, 'c' Capitation
  CarrierPhone VARCHAR(30) NOT NULL DEFAULT '',  -- denormalized carrier contact (A3)
  ElectID VARCHAR(20) NOT NULL DEFAULT '',       -- electronic payer id (A3)
  AnnualMax DOUBLE NOT NULL DEFAULT 0,           -- denormalized from benefit table (A3)
  Deductible DOUBLE NOT NULL DEFAULT 0,          -- denormalized from benefit table (A3)
  DateTStamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_insplan_stamp (DateTStamp)
);

CREATE TABLE IF NOT EXISTS patplan (
  PatPlanNum BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  PatNum BIGINT NOT NULL DEFAULT 0,
  PlanNum BIGINT NOT NULL DEFAULT 0,             -- simplified: direct to insplan (real OD goes via inssub)
  Ordinal TINYINT NOT NULL DEFAULT 1,
  SubscriberID VARCHAR(30) NOT NULL DEFAULT '',
  DateTStamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_patplan_stamp (DateTStamp),
  KEY idx_patplan_pat (PatNum)
);

CREATE TABLE IF NOT EXISTS claim (
  ClaimNum BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  PatNum BIGINT NOT NULL DEFAULT 0,
  DateService DATE NOT NULL DEFAULT '0001-01-01',
  DateSent DATE NOT NULL DEFAULT '0001-01-01',
  ClaimStatus VARCHAR(1) NOT NULL DEFAULT 'U',   -- U Unsent, H Hold, W Waiting, S Sent, R Received
  ClaimFee DOUBLE NOT NULL DEFAULT 0,
  InsPayEst DOUBLE NOT NULL DEFAULT 0,
  InsPayAmt DOUBLE NOT NULL DEFAULT 0,
  PlanNum BIGINT NOT NULL DEFAULT 0,
  ProvTreat BIGINT NOT NULL DEFAULT 0,
  ClaimNote VARCHAR(400) NOT NULL DEFAULT '',
  CarcCodes VARCHAR(50) NOT NULL DEFAULT '',     -- sim convention: comma-joined CARC codes on denial (A3)
  SecDateTEdit TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  DateTStamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_claim_stamp (DateTStamp),
  KEY idx_claim_pat (PatNum)
);

CREATE TABLE IF NOT EXISTS claimproc (
  ClaimProcNum BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ClaimNum BIGINT NOT NULL DEFAULT 0,
  ProcNum BIGINT NOT NULL DEFAULT 0,
  PatNum BIGINT NOT NULL DEFAULT 0,
  PlanNum BIGINT NOT NULL DEFAULT 0,
  Status TINYINT NOT NULL DEFAULT 0,             -- 0 NotReceived, 1 Received, 4 Supplemental
  FeeBilled DOUBLE NOT NULL DEFAULT 0,
  InsPayEst DOUBLE NOT NULL DEFAULT 0,
  InsPayAmt DOUBLE NOT NULL DEFAULT 0,
  WriteOff DOUBLE NOT NULL DEFAULT 0,
  DateTStamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_claimproc_stamp (DateTStamp),
  KEY idx_claimproc_claim (ClaimNum)
);

CREATE TABLE IF NOT EXISTS recall (
  RecallNum BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  PatNum BIGINT NOT NULL DEFAULT 0,
  DateDueCalc DATE NOT NULL DEFAULT '0001-01-01',
  DateDue DATE NOT NULL DEFAULT '0001-01-01',
  DatePrevious DATE NOT NULL DEFAULT '0001-01-01',
  RecallInterval INT NOT NULL DEFAULT 0,         -- encoded; sim uses months directly
  RecallStatus BIGINT NOT NULL DEFAULT 0,
  IsDisabled TINYINT NOT NULL DEFAULT 0,
  DateTStamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_recall_stamp (DateTStamp),
  KEY idx_recall_pat (PatNum)
);

CREATE TABLE IF NOT EXISTS payment (
  PayNum BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  PatNum BIGINT NOT NULL DEFAULT 0,
  PayDate DATE NOT NULL DEFAULT '0001-01-01',
  PayAmt DOUBLE NOT NULL DEFAULT 0,
  PayType BIGINT NOT NULL DEFAULT 0,             -- sim: 1 check, 2 card, 3 cash, 4 insurance EFT
  PayNote VARCHAR(255) NOT NULL DEFAULT '',
  DateTStamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_payment_stamp (DateTStamp),
  KEY idx_payment_pat (PatNum)
);

CREATE TABLE IF NOT EXISTS paysplit (
  SplitNum BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  PayNum BIGINT NOT NULL DEFAULT 0,
  PatNum BIGINT NOT NULL DEFAULT 0,
  ProcNum BIGINT NOT NULL DEFAULT 0,
  SplitAmt DOUBLE NOT NULL DEFAULT 0,
  DatePay DATE NOT NULL DEFAULT '0001-01-01',
  DateTStamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_paysplit_stamp (DateTStamp),
  KEY idx_paysplit_pay (PayNum)
);

CREATE TABLE IF NOT EXISTS commlog (
  CommlogNum BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  PatNum BIGINT NOT NULL DEFAULT 0,
  CommDateTime DATETIME NOT NULL DEFAULT '0001-01-01 00:00:00',
  CommType BIGINT NOT NULL DEFAULT 0,            -- sim: 1 appointment-related, 2 billing, 3 clinical note, 4 text message
  Note TEXT,
  Mode_ TINYINT NOT NULL DEFAULT 0,              -- 0 None, 1 Email, 2 Phone, 3 Mail, 4 InPerson, 5 Text
  SentOrReceived TINYINT NOT NULL DEFAULT 0,     -- 0 Neither, 1 Sent, 2 Received
  DateTStamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_commlog_stamp (DateTStamp),
  KEY idx_commlog_pat (PatNum)
);
