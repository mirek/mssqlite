/** SQLite DDL for the catalog backing tables and derived views. */
export const tables: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "sys.schemas" (
    schema_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    principal_id INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.types" (
    user_type_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE,
    system_type_id INTEGER NOT NULL,
    schema_id INTEGER NOT NULL DEFAULT 4,
    principal_id INTEGER,
    max_length INTEGER NOT NULL,
    precision INTEGER NOT NULL DEFAULT 0,
    scale INTEGER NOT NULL DEFAULT 0,
    collation_name TEXT,
    is_nullable INTEGER NOT NULL DEFAULT 1,
    is_user_defined INTEGER NOT NULL DEFAULT 0,
    is_assembly_type INTEGER NOT NULL DEFAULT 0,
    default_object_id INTEGER NOT NULL DEFAULT 0,
    rule_object_id INTEGER NOT NULL DEFAULT 0,
    is_table_type INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.objects" (
    object_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE,
    principal_id INTEGER,
    schema_id INTEGER NOT NULL DEFAULT 1,
    parent_object_id INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL,
    type_desc TEXT NOT NULL,
    create_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    modify_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    is_ms_shipped INTEGER NOT NULL DEFAULT 0,
    is_published INTEGER NOT NULL DEFAULT 0,
    is_schema_published INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.columns" (
    object_id INTEGER NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    column_id INTEGER NOT NULL,
    system_type_id INTEGER NOT NULL,
    user_type_id INTEGER NOT NULL,
    max_length INTEGER NOT NULL,
    precision INTEGER NOT NULL DEFAULT 0,
    scale INTEGER NOT NULL DEFAULT 0,
    collation_name TEXT,
    is_nullable INTEGER NOT NULL DEFAULT 1,
    is_ansi_padded INTEGER NOT NULL DEFAULT 0,
    is_rowguidcol INTEGER NOT NULL DEFAULT 0,
    is_identity INTEGER NOT NULL DEFAULT 0,
    is_computed INTEGER NOT NULL DEFAULT 0,
    is_filestream INTEGER NOT NULL DEFAULT 0,
    is_replicated INTEGER NOT NULL DEFAULT 0,
    is_non_sql_subscribed INTEGER NOT NULL DEFAULT 0,
    is_merge_published INTEGER NOT NULL DEFAULT 0,
    is_dts_replicated INTEGER NOT NULL DEFAULT 0,
    is_xml_document INTEGER NOT NULL DEFAULT 0,
    xml_collection_id INTEGER NOT NULL DEFAULT 0,
    default_object_id INTEGER NOT NULL DEFAULT 0,
    rule_object_id INTEGER NOT NULL DEFAULT 0,
    is_sparse INTEGER NOT NULL DEFAULT 0,
    is_column_set INTEGER NOT NULL DEFAULT 0,
    generated_always_type INTEGER NOT NULL DEFAULT 0,
    generated_always_type_desc TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
    is_hidden INTEGER NOT NULL DEFAULT 0,
    is_masked INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (object_id, column_id)
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.indexes" (
    object_id INTEGER NOT NULL,
    name TEXT COLLATE NOCASE,
    index_id INTEGER NOT NULL,
    type INTEGER NOT NULL DEFAULT 0,
    type_desc TEXT NOT NULL DEFAULT 'HEAP',
    is_unique INTEGER NOT NULL DEFAULT 0,
    data_space_id INTEGER NOT NULL DEFAULT 1,
    ignore_dup_key INTEGER NOT NULL DEFAULT 0,
    is_primary_key INTEGER NOT NULL DEFAULT 0,
    is_unique_constraint INTEGER NOT NULL DEFAULT 0,
    fill_factor INTEGER NOT NULL DEFAULT 0,
    is_padded INTEGER NOT NULL DEFAULT 0,
    is_disabled INTEGER NOT NULL DEFAULT 0,
    is_hypothetical INTEGER NOT NULL DEFAULT 0,
    allow_row_locks INTEGER NOT NULL DEFAULT 1,
    allow_page_locks INTEGER NOT NULL DEFAULT 1,
    has_filter INTEGER NOT NULL DEFAULT 0,
    filter_definition TEXT,
    PRIMARY KEY (object_id, index_id)
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.index_columns" (
    object_id INTEGER NOT NULL,
    index_id INTEGER NOT NULL,
    index_column_id INTEGER NOT NULL,
    column_id INTEGER NOT NULL,
    key_ordinal INTEGER NOT NULL DEFAULT 0,
    partition_ordinal INTEGER NOT NULL DEFAULT 0,
    is_descending_key INTEGER NOT NULL DEFAULT 0,
    is_included_column INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (object_id, index_id, index_column_id)
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.foreign_keys" (
    object_id INTEGER PRIMARY KEY,
    referenced_object_id INTEGER NOT NULL,
    key_index_id INTEGER NOT NULL DEFAULT 0,
    is_disabled INTEGER NOT NULL DEFAULT 0,
    is_not_for_replication INTEGER NOT NULL DEFAULT 0,
    is_not_trusted INTEGER NOT NULL DEFAULT 0,
    delete_referential_action INTEGER NOT NULL DEFAULT 0,
    delete_referential_action_desc TEXT NOT NULL DEFAULT 'NO_ACTION',
    update_referential_action INTEGER NOT NULL DEFAULT 0,
    update_referential_action_desc TEXT NOT NULL DEFAULT 'NO_ACTION',
    is_system_named INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.foreign_key_columns" (
    constraint_object_id INTEGER NOT NULL,
    constraint_column_id INTEGER NOT NULL,
    parent_object_id INTEGER NOT NULL,
    parent_column_id INTEGER NOT NULL,
    referenced_object_id INTEGER NOT NULL,
    referenced_column_id INTEGER NOT NULL,
    PRIMARY KEY (constraint_object_id, constraint_column_id)
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.key_constraints" (
    object_id INTEGER PRIMARY KEY,
    unique_index_id INTEGER NOT NULL,
    is_system_named INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.check_constraints" (
    object_id INTEGER PRIMARY KEY,
    is_disabled INTEGER NOT NULL DEFAULT 0,
    is_not_for_replication INTEGER NOT NULL DEFAULT 0,
    is_not_trusted INTEGER NOT NULL DEFAULT 0,
    parent_column_id INTEGER NOT NULL DEFAULT 0,
    definition TEXT,
    uses_database_collation INTEGER NOT NULL DEFAULT 0,
    is_system_named INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.default_constraints_extra" (
    object_id INTEGER PRIMARY KEY,
    parent_column_id INTEGER NOT NULL,
    definition TEXT,
    is_system_named INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.databases" (
    database_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    create_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    compatibility_level INTEGER NOT NULL DEFAULT 150,
    collation_name TEXT DEFAULT 'SQL_Latin1_General_CP1_CI_AS',
    user_access INTEGER NOT NULL DEFAULT 0,
    user_access_desc TEXT NOT NULL DEFAULT 'MULTI_USER',
    is_read_only INTEGER NOT NULL DEFAULT 0,
    state INTEGER NOT NULL DEFAULT 0,
    state_desc TEXT NOT NULL DEFAULT 'ONLINE',
    recovery_model INTEGER NOT NULL DEFAULT 3,
    recovery_model_desc TEXT NOT NULL DEFAULT 'SIMPLE',
    is_auto_close_on INTEGER NOT NULL DEFAULT 0,
    is_auto_shrink_on INTEGER NOT NULL DEFAULT 0,
    is_fulltext_enabled INTEGER NOT NULL DEFAULT 0,
    is_ansi_null_default_on INTEGER NOT NULL DEFAULT 0,
    is_ansi_nulls_on INTEGER NOT NULL DEFAULT 1,
    is_ansi_padding_on INTEGER NOT NULL DEFAULT 1,
    is_ansi_warnings_on INTEGER NOT NULL DEFAULT 1,
    is_quoted_identifier_on INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.database_principals" (
    principal_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE,
    type TEXT NOT NULL,
    type_desc TEXT NOT NULL,
    default_schema_name TEXT,
    create_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    modify_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    owning_principal_id INTEGER,
    sid BLOB,
    is_fixed_role INTEGER NOT NULL DEFAULT 0,
    authentication_type INTEGER NOT NULL DEFAULT 1,
    authentication_type_desc TEXT NOT NULL DEFAULT 'INSTANCE'
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.server_principals" (
    principal_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE,
    sid BLOB,
    type TEXT NOT NULL,
    type_desc TEXT NOT NULL,
    is_disabled INTEGER NOT NULL DEFAULT 0,
    create_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    modify_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    default_database_name TEXT DEFAULT 'master',
    default_language_name TEXT DEFAULT 'us_english',
    is_fixed_role INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.identity_columns_extra" (
    object_id INTEGER NOT NULL,
    column_id INTEGER NOT NULL,
    seed_value TEXT DEFAULT '1',
    increment_value TEXT DEFAULT '1',
    last_value TEXT,
    is_not_for_replication INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (object_id, column_id)
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.computed_columns_extra" (
    object_id INTEGER NOT NULL,
    column_id INTEGER NOT NULL,
    definition TEXT,
    uses_database_collation INTEGER NOT NULL DEFAULT 0,
    is_persisted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (object_id, column_id)
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.sql_modules" (
    object_id INTEGER PRIMARY KEY,
    definition TEXT,
    uses_ansi_nulls INTEGER NOT NULL DEFAULT 1,
    uses_quoted_identifier INTEGER NOT NULL DEFAULT 1,
    is_schema_bound INTEGER NOT NULL DEFAULT 0,
    uses_database_collation INTEGER NOT NULL DEFAULT 0,
    is_recompiled INTEGER NOT NULL DEFAULT 0,
    null_on_null_input INTEGER NOT NULL DEFAULT 0,
    execute_as_principal_id INTEGER,
    uses_native_compilation INTEGER NOT NULL DEFAULT 0,
    is_inlineable INTEGER NOT NULL DEFAULT 0,
    inline_type INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.routine_metadata" (
    object_id INTEGER PRIMARY KEY,
    data_type TEXT,
    character_maximum_length INTEGER,
    character_octet_length INTEGER,
    collation_name TEXT,
    character_set_name TEXT,
    numeric_precision INTEGER,
    numeric_precision_radix INTEGER,
    numeric_scale INTEGER,
    datetime_precision INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.dm_exec_sessions" (
    session_id INTEGER PRIMARY KEY,
    login_time TEXT NOT NULL,
    host_name TEXT,
    program_name TEXT,
    host_process_id INTEGER,
    client_version INTEGER,
    client_interface_name TEXT,
    login_name TEXT NOT NULL,
    status TEXT NOT NULL,
    database_id INTEGER NOT NULL DEFAULT 5,
    open_transaction_count INTEGER NOT NULL DEFAULT 0,
    last_request_start_time TEXT,
    last_request_end_time TEXT,
    row_count INTEGER NOT NULL DEFAULT 0,
    prev_error INTEGER NOT NULL DEFAULT 0,
    original_login_name TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.dm_exec_requests" (
    session_id INTEGER NOT NULL,
    request_id INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    status TEXT NOT NULL,
    command TEXT NOT NULL,
    database_id INTEGER NOT NULL DEFAULT 5,
    user_id INTEGER NOT NULL DEFAULT 1,
    blocking_session_id INTEGER NOT NULL DEFAULT 0,
    wait_type TEXT,
    wait_time INTEGER NOT NULL DEFAULT 0,
    wait_resource TEXT NOT NULL DEFAULT '',
    open_transaction_count INTEGER NOT NULL DEFAULT 0,
    percent_complete REAL NOT NULL DEFAULT 0,
    cpu_time INTEGER NOT NULL DEFAULT 0,
    total_elapsed_time INTEGER NOT NULL DEFAULT 0,
    reads INTEGER NOT NULL DEFAULT 0,
    writes INTEGER NOT NULL DEFAULT 0,
    logical_reads INTEGER NOT NULL DEFAULT 0,
    row_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, request_id)
  )`,
  `CREATE TABLE IF NOT EXISTS "sys._database_context" (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    name TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.sequence_state" (
    object_id INTEGER PRIMARY KEY,
    system_type_id INTEGER NOT NULL,
    user_type_id INTEGER NOT NULL,
    precision INTEGER NOT NULL,
    scale INTEGER NOT NULL DEFAULT 0,
    start_value TEXT NOT NULL,
    increment_value TEXT NOT NULL,
    minimum_value TEXT NOT NULL,
    maximum_value TEXT NOT NULL,
    is_cycling INTEGER NOT NULL DEFAULT 0,
    is_cached INTEGER NOT NULL DEFAULT 1,
    cache_size INTEGER,
    current_value TEXT NOT NULL,
    is_exhausted INTEGER NOT NULL DEFAULT 0,
    last_used_value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS "sys.rowversion_state" (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    current_value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "sys._next_id" (
    next_id INTEGER NOT NULL
  )`
] as const

export const views: readonly string[] = [
  `CREATE VIEW IF NOT EXISTS "sys.default_constraints" AS
    SELECT o.*, d.parent_column_id, d.definition, d.is_system_named
    FROM "sys.objects" o
    JOIN "sys.default_constraints_extra" d ON d.object_id = o.object_id
    WHERE o.type = 'D'`,
  `CREATE VIEW IF NOT EXISTS "sys.tables" AS
    SELECT o.*,
      0 AS lob_data_space_id, NULL AS filestream_data_space_id,
      (SELECT MAX(c.column_id) FROM "sys.columns" c WHERE c.object_id = o.object_id) AS max_column_id_used,
      0 AS lock_on_bulk_load, 1 AS uses_ansi_nulls, 0 AS is_replicated,
      0 AS has_replication_filter, 0 AS is_merge_published, 0 AS is_sync_tran_subscribed,
      0 AS has_unchecked_assembly_data, 0 AS text_in_row_limit, 0 AS large_value_types_out_of_row,
      0 AS is_tracked_by_cdc, 0 AS lock_escalation, 'TABLE' AS lock_escalation_desc,
      0 AS is_filetable, 0 AS is_memory_optimized, 0 AS durability,
      'SCHEMA_AND_DATA' AS durability_desc, 0 AS temporal_type,
      'NON_TEMPORAL_TABLE' AS temporal_type_desc, NULL AS history_table_id,
      0 AS is_remote_data_archive_enabled, 0 AS is_external, 0 AS is_node, 0 AS is_edge
    FROM "sys.objects" o WHERE o.type = 'U'`,
  `CREATE VIEW IF NOT EXISTS "sys.views" AS
    SELECT o.*,
      0 AS is_date_correlation_view, 0 AS is_tracked_by_cdc, 0 AS has_snapshot_definition,
      0 AS has_opaque_metadata, 0 AS has_unchecked_assembly_data, 0 AS with_check_option,
      0 AS is_replicated
    FROM "sys.objects" o WHERE o.type = 'V'`,
  `CREATE VIEW IF NOT EXISTS "sys.procedures" AS
    SELECT o.* FROM "sys.objects" o WHERE o.type = 'P'`,
  `CREATE VIEW IF NOT EXISTS "sys.identity_columns" AS
    SELECT c.*, ic.seed_value, ic.increment_value, ic.last_value, ic.is_not_for_replication
    FROM "sys.columns" c
    JOIN "sys.identity_columns_extra" ic
      ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE c.is_identity = 1`,
  `CREATE VIEW IF NOT EXISTS "sys.computed_columns" AS
    SELECT c.*, cc.definition, cc.uses_database_collation, cc.is_persisted
    FROM "sys.columns" c
    JOIN "sys.computed_columns_extra" cc
      ON c.object_id = cc.object_id AND c.column_id = cc.column_id
    WHERE c.is_computed = 1`,
  `CREATE VIEW IF NOT EXISTS "sys.sequences" AS
    SELECT o.*,
      q.system_type_id, q.user_type_id, q.precision, q.scale,
      CAST(q.start_value AS INTEGER) AS start_value,
      CAST(q.increment_value AS INTEGER) AS increment,
      CAST(q.minimum_value AS INTEGER) AS minimum_value,
      CAST(q.maximum_value AS INTEGER) AS maximum_value,
      q.is_cycling, q.is_cached, q.cache_size,
      CAST(q.current_value AS INTEGER) AS current_value,
      q.is_exhausted,
      CASE WHEN q.last_used_value IS NULL THEN NULL ELSE CAST(q.last_used_value AS INTEGER) END AS last_used_value
    FROM "sys.objects" o
    JOIN "sys.sequence_state" q ON q.object_id = o.object_id
    WHERE o.type = 'SO'`,
  `CREATE VIEW IF NOT EXISTS "information_schema.tables" AS
    SELECT
      (SELECT name FROM "sys._database_context" WHERE singleton = 1) AS TABLE_CATALOG,
      s.name AS TABLE_SCHEMA,
      o.name AS TABLE_NAME,
      CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'BASE TABLE' END AS TABLE_TYPE
    FROM "sys.objects" o
    JOIN "sys.schemas" s ON s.schema_id = o.schema_id
    WHERE o.type IN ('U', 'V')`,
  `CREATE VIEW IF NOT EXISTS "information_schema.columns" AS
    SELECT
      (SELECT name FROM "sys._database_context" WHERE singleton = 1) AS TABLE_CATALOG,
      s.name AS TABLE_SCHEMA,
      o.name AS TABLE_NAME,
      c.name AS COLUMN_NAME,
      c.column_id AS ORDINAL_POSITION,
      CASE c.is_nullable WHEN 1 THEN 'YES' ELSE 'NO' END AS IS_NULLABLE,
      t.name AS DATA_TYPE,
      CASE WHEN c.max_length = -1 THEN -1
        WHEN t.name IN ('nvarchar', 'nchar', 'sysname') THEN c.max_length / 2
        ELSE c.max_length END AS CHARACTER_MAXIMUM_LENGTH,
      c.precision AS NUMERIC_PRECISION,
      c.scale AS NUMERIC_SCALE,
      c.collation_name AS COLLATION_NAME
    FROM "sys.columns" c
    JOIN "sys.objects" o ON o.object_id = c.object_id
    JOIN "sys.schemas" s ON s.schema_id = o.schema_id
    LEFT JOIN "sys.types" t ON t.user_type_id = c.user_type_id`,
  `CREATE VIEW IF NOT EXISTS "information_schema.views" AS
    SELECT
      (SELECT name FROM "sys._database_context" WHERE singleton = 1) AS TABLE_CATALOG,
      s.name AS TABLE_SCHEMA,
      o.name AS TABLE_NAME,
      substr(m.definition, 1, 4000) AS VIEW_DEFINITION,
      CASE v.with_check_option WHEN 1 THEN 'CASCADE' ELSE 'NONE' END AS CHECK_OPTION,
      'NO' AS IS_UPDATABLE
    FROM "sys.views" v
    JOIN "sys.objects" o ON o.object_id = v.object_id
    JOIN "sys.schemas" s ON s.schema_id = o.schema_id
    LEFT JOIN "sys.sql_modules" m ON m.object_id = o.object_id`,
  `CREATE VIEW IF NOT EXISTS "information_schema.routines" AS
    SELECT
      d.name AS SPECIFIC_CATALOG, s.name AS SPECIFIC_SCHEMA, o.name AS SPECIFIC_NAME,
      d.name AS ROUTINE_CATALOG, s.name AS ROUTINE_SCHEMA, o.name AS ROUTINE_NAME,
      CASE o.type WHEN 'P' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS ROUTINE_TYPE,
      NULL AS MODULE_CATALOG, NULL AS MODULE_SCHEMA, NULL AS MODULE_NAME,
      NULL AS UDT_CATALOG, NULL AS UDT_SCHEMA, NULL AS UDT_NAME,
      r.data_type AS DATA_TYPE,
      r.character_maximum_length AS CHARACTER_MAXIMUM_LENGTH,
      r.character_octet_length AS CHARACTER_OCTET_LENGTH,
      NULL AS COLLATION_CATALOG, NULL AS COLLATION_SCHEMA, r.collation_name AS COLLATION_NAME,
      NULL AS CHARACTER_SET_CATALOG, NULL AS CHARACTER_SET_SCHEMA,
      r.character_set_name AS CHARACTER_SET_NAME,
      r.numeric_precision AS NUMERIC_PRECISION,
      r.numeric_precision_radix AS NUMERIC_PRECISION_RADIX,
      r.numeric_scale AS NUMERIC_SCALE, r.datetime_precision AS DATETIME_PRECISION,
      NULL AS INTERVAL_TYPE, NULL AS INTERVAL_PRECISION,
      NULL AS TYPE_UDT_CATALOG, NULL AS TYPE_UDT_SCHEMA, NULL AS TYPE_UDT_NAME,
      NULL AS SCOPE_CATALOG, NULL AS SCOPE_SCHEMA, NULL AS SCOPE_NAME,
      NULL AS MAXIMUM_CARDINALITY, NULL AS DTD_IDENTIFIER,
      'SQL' AS ROUTINE_BODY, substr(m.definition, 1, 4000) AS ROUTINE_DEFINITION,
      NULL AS EXTERNAL_NAME, NULL AS EXTERNAL_LANGUAGE, NULL AS PARAMETER_STYLE,
      'NO' AS IS_DETERMINISTIC,
      CASE o.type WHEN 'P' THEN 'MODIFIES' ELSE 'READS' END AS SQL_DATA_ACCESS,
      CASE WHEN o.type = 'P' THEN NULL ELSE 'YES' END AS IS_NULL_CALL,
      NULL AS SQL_PATH, 'YES' AS SCHEMA_LEVEL_ROUTINE,
      CASE o.type WHEN 'P' THEN NULL ELSE 0 END AS MAX_DYNAMIC_RESULT_SETS,
      'NO' AS IS_USER_DEFINED_CAST, 'NO' AS IS_IMPLICITLY_INVOCABLE,
      o.create_date AS CREATED, o.modify_date AS LAST_ALTERED
    FROM "sys.objects" o
    JOIN "sys.schemas" s ON s.schema_id = o.schema_id
    CROSS JOIN "sys._database_context" d
    JOIN "sys.sql_modules" m ON m.object_id = o.object_id
    LEFT JOIN "sys.routine_metadata" r ON r.object_id = o.object_id
    WHERE d.singleton = 1 AND o.type IN ('P', 'FN', 'IF')`,
  `CREATE VIEW IF NOT EXISTS "information_schema.table_constraints" AS
    SELECT
      d.name AS CONSTRAINT_CATALOG, cs.name AS CONSTRAINT_SCHEMA, co.name AS CONSTRAINT_NAME,
      d.name AS TABLE_CATALOG, ts.name AS TABLE_SCHEMA, t.name AS TABLE_NAME,
      CASE co.type WHEN 'PK' THEN 'PRIMARY KEY' WHEN 'UQ' THEN 'UNIQUE'
        WHEN 'F' THEN 'FOREIGN KEY' ELSE 'CHECK' END AS CONSTRAINT_TYPE,
      'NO' AS IS_DEFERRABLE, 'NO' AS INITIALLY_DEFERRED
    FROM "sys.objects" co
    JOIN "sys.schemas" cs ON cs.schema_id = co.schema_id
    JOIN "sys.objects" t ON t.object_id = co.parent_object_id
    JOIN "sys.schemas" ts ON ts.schema_id = t.schema_id
    CROSS JOIN "sys._database_context" d
    WHERE d.singleton = 1 AND co.type IN ('PK', 'UQ', 'F', 'C')`,
  `CREATE VIEW IF NOT EXISTS "information_schema.key_column_usage" AS
    SELECT d.name AS CONSTRAINT_CATALOG, s.name AS CONSTRAINT_SCHEMA,
      co.name AS CONSTRAINT_NAME, d.name AS TABLE_CATALOG, s.name AS TABLE_SCHEMA,
      t.name AS TABLE_NAME, c.name AS COLUMN_NAME, ic.key_ordinal AS ORDINAL_POSITION
    FROM "sys.key_constraints" kc
    JOIN "sys.objects" co ON co.object_id = kc.object_id
    JOIN "sys.objects" t ON t.object_id = co.parent_object_id
    JOIN "sys.schemas" s ON s.schema_id = t.schema_id
    JOIN "sys.index_columns" ic
      ON ic.object_id = t.object_id AND ic.index_id = kc.unique_index_id
    JOIN "sys.columns" c ON c.object_id = t.object_id AND c.column_id = ic.column_id
    CROSS JOIN "sys._database_context" d WHERE d.singleton = 1
    UNION ALL
    SELECT d.name, s.name, co.name, d.name, s.name, t.name, c.name,
      fc.constraint_column_id
    FROM "sys.foreign_key_columns" fc
    JOIN "sys.objects" co ON co.object_id = fc.constraint_object_id
    JOIN "sys.objects" t ON t.object_id = fc.parent_object_id
    JOIN "sys.schemas" s ON s.schema_id = t.schema_id
    JOIN "sys.columns" c ON c.object_id = t.object_id AND c.column_id = fc.parent_column_id
    CROSS JOIN "sys._database_context" d WHERE d.singleton = 1`,
  `CREATE VIEW IF NOT EXISTS "information_schema.referential_constraints" AS
    SELECT d.name AS CONSTRAINT_CATALOG, ps.name AS CONSTRAINT_SCHEMA,
      fko.name AS CONSTRAINT_NAME, d.name AS UNIQUE_CONSTRAINT_CATALOG,
      rs.name AS UNIQUE_CONSTRAINT_SCHEMA, rko.name AS UNIQUE_CONSTRAINT_NAME,
      'SIMPLE' AS MATCH_OPTION,
      replace(fk.update_referential_action_desc, '_', ' ') AS UPDATE_RULE,
      replace(fk.delete_referential_action_desc, '_', ' ') AS DELETE_RULE
    FROM "sys.foreign_keys" fk
    JOIN "sys.objects" fko ON fko.object_id = fk.object_id
    JOIN "sys.schemas" ps ON ps.schema_id = fko.schema_id
    JOIN "sys.objects" rt ON rt.object_id = fk.referenced_object_id
    JOIN "sys.schemas" rs ON rs.schema_id = rt.schema_id
    LEFT JOIN "sys.key_constraints" rkc
      ON rkc.unique_index_id = fk.key_index_id
      AND EXISTS (SELECT 1 FROM "sys.objects" x
        WHERE x.object_id = rkc.object_id AND x.parent_object_id = rt.object_id)
    LEFT JOIN "sys.objects" rko ON rko.object_id = rkc.object_id
    CROSS JOIN "sys._database_context" d WHERE d.singleton = 1`
] as const
