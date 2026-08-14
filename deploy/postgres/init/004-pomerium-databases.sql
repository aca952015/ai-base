SELECT 'CREATE DATABASE ai_base_pomerium OWNER ai_base'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = 'ai_base_pomerium'
) \gexec
