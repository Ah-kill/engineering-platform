-- Developers can delete their own conversations; events go with them (ON DELETE CASCADE).
GRANT DELETE ON agent_sessions TO platform_app;
