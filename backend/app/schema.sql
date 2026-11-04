-- ============================================================
--  AI 政策搜索智能体 · 数据表结构（MySQL 8.0+）
--  ------------------------------------------------------------
--  四张表覆盖「账号 → 会话 → 检索记录 → 政策对话」：
--    · users           注册用户 + 企业档案（用户只需填一次）
--    · sessions        登录会话（Bearer Token 的哈希，可随时踢下线）
--    · search_records  每次检索的条件与结果快照（登录后自动回填前端）
--    · chat_messages   政策详情页里「问政策」的对话记录（按用户 + 政策隔离）
--
--  由 app/db.py::init_schema() 在服务启动时执行（CREATE ... IF NOT EXISTS，
--  可重复执行，不会破坏已有数据）。
-- ============================================================

-- ------------------------------------------------------------
-- 用户表：注册写入本表；企业档案字段让用户「填一次就够」
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '用户主键',
  `username`      VARCHAR(64)     NOT NULL                COMMENT '登录名（唯一）',
  `email`         VARCHAR(160)    NULL                    COMMENT '邮箱（可选，唯一）',
  `phone`         VARCHAR(32)     NULL                    COMMENT '手机号（可选）',
  `display_name`  VARCHAR(64)     NOT NULL                COMMENT '昵称 / 显示名',
  `password_hash` VARCHAR(255)    NOT NULL                COMMENT 'PBKDF2-HMAC-SHA256 哈希，绝不存明文',
  `company`       VARCHAR(128)    NULL                    COMMENT '企业名称',
  `industry`      VARCHAR(64)     NULL                    COMMENT '所属行业',
  `region_code`   VARCHAR(12)     NULL                    COMMENT '常用地域行政区划代码',
  `region_name`   VARCHAR(64)     NULL                    COMMENT '常用地域名称（如「杭州市」）',
  `status`        TINYINT         NOT NULL DEFAULT 1      COMMENT '1=正常 0=禁用',
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `last_login_at` DATETIME        NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`),
  UNIQUE KEY `uk_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='注册用户';

-- ------------------------------------------------------------
-- 会话表：登录签发随机 Token，库里只存 SHA-256 摘要
--   · 登出 = 删除该行（立即失效）
--   · 过期 = expires_at 到点后不再认
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sessions` (
  `token_hash`   CHAR(64)        NOT NULL                COMMENT 'Token 的 SHA-256 十六进制摘要',
  `user_id`      BIGINT UNSIGNED NOT NULL,
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最近一次带 Token 访问时间',
  `expires_at`   DATETIME        NOT NULL,
  `user_agent`   VARCHAR(255)    NULL,
  PRIMARY KEY (`token_hash`),
  KEY `idx_sessions_user` (`user_id`),
  KEY `idx_sessions_expires` (`expires_at`),
  CONSTRAINT `fk_sessions_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='登录会话';

-- ------------------------------------------------------------
-- 检索记录表：一次检索一行；result_json 原样保存包装好的十命名空间
--   · 登录用户再次打开应用时，直接回放最近一条，无需重新检索
--   · regions_json 存 JSON 数组文本，避免 MySQL JSON 类型改写键序
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `search_records` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`      BIGINT UNSIGNED NOT NULL,
  `task_id`      VARCHAR(40)     NOT NULL                COMMENT '本进程内的检索任务号',
  `query`        VARCHAR(500)    NOT NULL                COMMENT '用户原始问句',
  `regions_json` VARCHAR(512)    NOT NULL DEFAULT '[]'   COMMENT '地域条件，JSON 数组文本',
  `industries`   VARCHAR(120)    NULL,
  `types`        VARCHAR(120)    NULL,
  `deadline`     VARCHAR(40)     NULL,
  `status`       VARCHAR(16)     NOT NULL                COMMENT 'succeeded / failed / canceled',
  `provider`     VARCHAR(64)     NULL                    COMMENT '产出该结果的抽取引擎',
  `degraded`     TINYINT         NOT NULL DEFAULT 0      COMMENT '1=本次为降级兜底结果',
  `item_count`   INT             NOT NULL DEFAULT 0      COMMENT '政策条数',
  `avg_confidence` DECIMAL(4,3)  NOT NULL DEFAULT 0      COMMENT '平均置信度',
  `elapsed_ms`   INT             NOT NULL DEFAULT 0,
  `summary`      VARCHAR(255)    NULL                    COMMENT '一句话口径，供历史列表展示',
  `result_json`  LONGTEXT        NULL                    COMMENT '包装后的十命名空间快照',
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_records_task` (`task_id`),
  KEY `idx_records_user_time` (`user_id`, `id` DESC),
  CONSTRAINT `fk_records_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='检索记录（历史回放数据源）';

-- ------------------------------------------------------------
-- 政策对话表：政策详情页「问政策」的每一句话
--   · 一轮问答 = 两行（role=user 一行、role=assistant 一行）
--   · policy_id 让对话按政策隔离：同一条政策下接着聊，换政策就是新会话
--   · 只服务**登录用户**；游客可正常提问，但后端不写这张表（前端明确提示不保存）
--   · provider / degraded 如实记录这一句是怎么来的（远端模型 or 规则兜底），
--     降级时不假装成模型输出
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chat_messages` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    BIGINT UNSIGNED NOT NULL,
  `policy_id`  VARCHAR(64)     NOT NULL DEFAULT ''  COMMENT '对话绑定的政策 id（空串=未绑定）',
  `policy_name` VARCHAR(255)   NULL DEFAULT ''      COMMENT '政策名快照（对话记录页直接展示，免回查 bootstrap）',
  `role`       VARCHAR(16)     NOT NULL              COMMENT 'user=用户提问 / assistant=助手回答',
  `content`    TEXT            NOT NULL              COMMENT '正文（用户原话 / 助手回答全文）',
  `provider`   VARCHAR(64)     NULL                  COMMENT '产出该回答的引擎（远端模型名 / rule）',
  `degraded`   TINYINT         NOT NULL DEFAULT 0    COMMENT '1=本次回答为规则兜底，非模型原文',
  `elapsed_ms` INT             NOT NULL DEFAULT 0    COMMENT '该次回答耗时（用户提问行为 0）',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_chat_user_policy` (`user_id`, `policy_id`, `id`),
  CONSTRAINT `fk_chat_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='政策详情 · AI 对话记录';
