import dotenv from "dotenv";
dotenv.config();

const APP_NAME = "tnp";
const env = process.env.NODE_ENV || "development";

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  mongoUri: process.env.MONGODB_URI || "mongodb://localhost:27017",
  dbName: `${APP_NAME}-${env}`,
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",
  oxySsoSecret: process.env.OXY_SSO_SECRET || "",
  corsOrigins: [
    "http://localhost:5173",
    "https://tnp.network",
  ],
};
