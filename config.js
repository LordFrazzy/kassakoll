/* Inställningar för inloggning och synk (Supabase).
   Fyll i de två värdena från Supabase: Project Settings > API (se LAS-MIG.txt).
   Nyckeln är den publika "anon"-nyckeln och får ligga här; datan skyddas av reglerna i supabase.sql.
   Lämnas de tomma fungerar sidan som förut, utan inloggning, och sparar bara i webbläsaren. */
window.KASSAKOLL_CONFIG = {
  supabaseUrl: 'https://rnpyhqwzpudkcfplbiji.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJucHlocXd6cHVka2NmcGxiaWppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwMTk0NDAsImV4cCI6MjEwODU5NTQ0MH0.N-m58rg9SDyxePvnwOEQNFGf7U7aESkmJwHDCdD7LYA'
};
