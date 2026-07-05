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
  `CREATE TABLE IF NOT EXISTS "sys.default_constraints" (
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
    uses_native_compilation INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS "sys._next_id" (
    next_id INTEGER NOT NULL
  )`
] as const

export const views: readonly string[] = [
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
  `CREATE VIEW IF NOT EXISTS "information_schema.tables" AS
    SELECT
      (SELECT d.name FROM "sys.databases" d WHERE d.database_id = 5) AS TABLE_CATALOG,
      s.name AS TABLE_SCHEMA,
      o.name AS TABLE_NAME,
      CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'BASE TABLE' END AS TABLE_TYPE
    FROM "sys.objects" o
    JOIN "sys.schemas" s ON s.schema_id = o.schema_id
    WHERE o.type IN ('U', 'V')`,
  `CREATE VIEW IF NOT EXISTS "information_schema.columns" AS
    SELECT
      (SELECT d.name FROM "sys.databases" d WHERE d.database_id = 5) AS TABLE_CATALOG,
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
    LEFT JOIN "sys.types" t ON t.user_type_id = c.user_type_id`
] as const
