// middleware/auth.js - JWT verification + role guard
const jwt = require("jsonwebtoken");

// Verifies the Bearer token on every protected route
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, username, role, fullname }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Use after requireAuth to restrict a route to admins only
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };