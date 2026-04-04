import dotenv from "dotenv";
dotenv.config();

const APP_NAME = "tnp";
const env = process.env.NODE_ENV || "development";

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  mongoUri: process.env.MONGODB_URI || "mongodb://localhost:27017",
  dbName: `${APP_NAME}-${env}`,
  oxyApiUrl: process.env.OXY_API_URL || "https://api.oxy.so",
  parkingIp: process.env.TNP_PARKING_IP || "206.189.96.213",
  corsOrigins: [
    "http://localhost:5173",
    "https://tnp.network",
    "https://www.tnp.network",
    "https://tnp-9uk.pages.dev",
  ],
};
