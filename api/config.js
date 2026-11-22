/* Public runtime config. Values come from env vars, with the project's
   public Supabase URL/anon key as fallback so deploys work with zero setup. */
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    url: process.env.SUPABASE_URL || "https://yvqndfyiwkegxkeolvoh.supabase.co",
    key: process.env.SUPABASE_ANON_KEY || "sb_publishable_AVPKoEterodpUPjlLCn3RA_d6q3ZJNn",
    proxy: Boolean(req && req._hasSbProxy)
  });
};
