/* Inställningar för inloggning och synk (Supabase).
   Fyll i de två värdena från Supabase: Project Settings > API (se LAS-MIG.txt).
   Nyckeln är den publika "anon"-nyckeln och får ligga här; datan skyddas av reglerna i supabase.sql.
   Lämnas de tomma fungerar sidan som förut, utan inloggning, och sparar bara i webbläsaren. */
window.KASSAKOLL_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: ''
};
