-- MySQL dump 10.13  Distrib 5.7.42, for Linux (x86_64)
--
-- Host: localhost    Database: jambones_test
-- ------------------------------------------------------
-- Server version	5.7.42

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `account_limits`
--

DROP TABLE IF EXISTS `account_limits`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `account_limits` (
  `account_limits_sid` char(36) NOT NULL,
  `account_sid` char(36) NOT NULL,
  `category` enum('api_rate','voice_call_session','device','voice_call_minutes','voice_call_session_license','voice_call_minutes_license') NOT NULL,
  `quantity` int(11) NOT NULL,
  PRIMARY KEY (`account_limits_sid`),
  UNIQUE KEY `account_limits_sid` (`account_limits_sid`),
  KEY `account_sid_idx` (`account_sid`),
  CONSTRAINT `account_limits_ibfk_1` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `account_limits`
--

LOCK TABLES `account_limits` WRITE;
/*!40000 ALTER TABLE `account_limits` DISABLE KEYS */;
/*!40000 ALTER TABLE `account_limits` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `account_offers`
--

DROP TABLE IF EXISTS `account_offers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `account_offers` (
  `account_offer_sid` char(36) NOT NULL,
  `account_sid` char(36) NOT NULL,
  `product_sid` char(36) NOT NULL,
  `stripe_product_id` varchar(56) NOT NULL,
  PRIMARY KEY (`account_offer_sid`),
  UNIQUE KEY `account_offer_sid` (`account_offer_sid`),
  KEY `account_offer_sid_idx` (`account_offer_sid`),
  KEY `account_sid_idx` (`account_sid`),
  KEY `product_sid_idx` (`product_sid`),
  CONSTRAINT `account_offers_ibfk_1` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `account_offers_ibfk_2` FOREIGN KEY (`product_sid`) REFERENCES `products` (`product_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `account_offers`
--

LOCK TABLES `account_offers` WRITE;
/*!40000 ALTER TABLE `account_offers` DISABLE KEYS */;
/*!40000 ALTER TABLE `account_offers` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `account_products`
--

DROP TABLE IF EXISTS `account_products`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `account_products` (
  `account_product_sid` char(36) NOT NULL,
  `account_subscription_sid` char(36) NOT NULL,
  `product_sid` char(36) NOT NULL,
  `quantity` int(11) NOT NULL,
  PRIMARY KEY (`account_product_sid`),
  UNIQUE KEY `account_product_sid` (`account_product_sid`),
  KEY `account_product_sid_idx` (`account_product_sid`),
  KEY `account_subscription_sid_idx` (`account_subscription_sid`),
  KEY `product_sid_idxfk` (`product_sid`),
  CONSTRAINT `account_products_ibfk_1` FOREIGN KEY (`account_subscription_sid`) REFERENCES `account_subscriptions` (`account_subscription_sid`),
  CONSTRAINT `account_products_ibfk_2` FOREIGN KEY (`product_sid`) REFERENCES `products` (`product_sid`),
  CONSTRAINT `account_subscription_sid_idxfk` FOREIGN KEY (`account_subscription_sid`) REFERENCES `account_subscriptions` (`account_subscription_sid`),
  CONSTRAINT `product_sid_idxfk` FOREIGN KEY (`product_sid`) REFERENCES `products` (`product_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `account_products`
--

LOCK TABLES `account_products` WRITE;
/*!40000 ALTER TABLE `account_products` DISABLE KEYS */;
INSERT INTO `account_products` VALUES ('bb0e8a44-0e59-4103-a44c-f7ff950319fb','02639178-e073-4f8e-9b7e-48b1d36f4b7a','35a9fb10-233d-4eb9-aada-78de5814d680',10),('e2cd5148-07ad-4cdc-b395-22e4b4e23d7e','02639178-e073-4f8e-9b7e-48b1d36f4b7a','2c815913-5c26-4004-b748-183b459329df',10),('f9b320aa-c287-438b-a4c0-e4383b4f0256','02639178-e073-4f8e-9b7e-48b1d36f4b7a','c4403cdb-8e75-4b27-9726-7d8315e3216d',10);
/*!40000 ALTER TABLE `account_products` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `account_static_ips`
--

DROP TABLE IF EXISTS `account_static_ips`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `account_static_ips` (
  `account_static_ip_sid` char(36) NOT NULL,
  `account_sid` char(36) NOT NULL,
  `ipv4` varchar(16) NOT NULL,
  `sbc_address_sid` char(36) NOT NULL,
  PRIMARY KEY (`account_static_ip_sid`),
  UNIQUE KEY `account_static_ip_sid` (`account_static_ip_sid`),
  UNIQUE KEY `ipv4` (`ipv4`),
  KEY `account_static_ip_sid_idx` (`account_static_ip_sid`),
  KEY `account_sid_idx` (`account_sid`),
  KEY `sbc_address_sid_idxfk` (`sbc_address_sid`),
  CONSTRAINT `account_sid_idxfk_3` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `account_static_ips_ibfk_1` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `sbc_address_sid_idxfk` FOREIGN KEY (`sbc_address_sid`) REFERENCES `sbc_addresses` (`sbc_address_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `account_static_ips`
--

LOCK TABLES `account_static_ips` WRITE;
/*!40000 ALTER TABLE `account_static_ips` DISABLE KEYS */;
/*!40000 ALTER TABLE `account_static_ips` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `account_subscriptions`
--

DROP TABLE IF EXISTS `account_subscriptions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `account_subscriptions` (
  `account_subscription_sid` char(36) NOT NULL,
  `account_sid` char(36) NOT NULL,
  `pending` tinyint(1) NOT NULL DEFAULT '0',
  `effective_start_date` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `effective_end_date` datetime DEFAULT NULL,
  `change_reason` varchar(255) DEFAULT NULL,
  `stripe_subscription_id` varchar(56) DEFAULT NULL,
  `stripe_payment_method_id` varchar(56) DEFAULT NULL,
  `stripe_statement_descriptor` varchar(255) DEFAULT NULL,
  `last4` char(4) DEFAULT NULL,
  `exp_month` int(11) DEFAULT NULL,
  `exp_year` int(11) DEFAULT NULL,
  `card_type` varchar(16) DEFAULT NULL,
  `pending_reason` varbinary(52) DEFAULT NULL,
  PRIMARY KEY (`account_subscription_sid`),
  UNIQUE KEY `account_subscription_sid` (`account_subscription_sid`),
  KEY `account_subscription_sid_idx` (`account_subscription_sid`),
  KEY `account_sid_idx` (`account_sid`),
  CONSTRAINT `account_sid_idxfk` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `account_subscriptions_ibfk_1` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `account_subscriptions`
--

LOCK TABLES `account_subscriptions` WRITE;
/*!40000 ALTER TABLE `account_subscriptions` DISABLE KEYS */;
INSERT INTO `account_subscriptions` VALUES ('02639178-e073-4f8e-9b7e-48b1d36f4b7a','bb845d4b-83a9-4cde-a6e9-50f3743bab3f',0,'2021-04-03 15:41:03',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
/*!40000 ALTER TABLE `account_subscriptions` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `accounts`
--

DROP TABLE IF EXISTS `accounts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `accounts` (
  `account_sid` char(36) NOT NULL,
  `name` varchar(64) NOT NULL,
  `sip_realm` varchar(132) DEFAULT NULL COMMENT 'sip domain that will be used for devices registering under this account',
  `service_provider_sid` char(36) NOT NULL COMMENT 'service provider that owns the customer relationship with this account',
  `registration_hook_sid` char(36) DEFAULT NULL COMMENT 'webhook to call when devices underr this account attempt to register',
  `queue_event_hook_sid` char(36) DEFAULT NULL,
  `device_calling_application_sid` char(36) DEFAULT NULL COMMENT 'application to use for outbound calling from an account',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `plan_type` enum('trial','free','paid') NOT NULL DEFAULT 'trial',
  `stripe_customer_id` varchar(56) DEFAULT NULL,
  `webhook_secret` varchar(36) NOT NULL,
  `disable_cdrs` tinyint(1) NOT NULL DEFAULT '0',
  `trial_end_date` datetime DEFAULT NULL,
  `deactivated_reason` varchar(255) DEFAULT NULL,
  `device_to_call_ratio` int(11) NOT NULL DEFAULT '5',
  `subspace_client_id` varchar(255) DEFAULT NULL,
  `subspace_client_secret` varchar(255) DEFAULT NULL,
  `subspace_sip_teleport_id` varchar(255) DEFAULT NULL,
  `subspace_sip_teleport_destinations` varchar(255) DEFAULT NULL,
  `siprec_hook_sid` char(36) DEFAULT NULL,
  PRIMARY KEY (`account_sid`),
  UNIQUE KEY `account_sid` (`account_sid`),
  UNIQUE KEY `sip_realm` (`sip_realm`),
  KEY `account_sid_idx` (`account_sid`),
  KEY `sip_realm_idx` (`sip_realm`),
  KEY `service_provider_sid_idx` (`service_provider_sid`),
  KEY `registration_hook_sid_idxfk_1` (`registration_hook_sid`),
  KEY `device_calling_application_sid_idxfk` (`device_calling_application_sid`),
  KEY `siprec_hook_sid_idxfk` (`siprec_hook_sid`),
  KEY `queue_event_hook_sid_idxfk` (`queue_event_hook_sid`),
  CONSTRAINT `accounts_ibfk_1` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`),
  CONSTRAINT `accounts_ibfk_2` FOREIGN KEY (`registration_hook_sid`) REFERENCES `webhooks` (`webhook_sid`),
  CONSTRAINT `accounts_ibfk_3` FOREIGN KEY (`device_calling_application_sid`) REFERENCES `applications` (`application_sid`),
  CONSTRAINT `accounts_ibfk_4` FOREIGN KEY (`siprec_hook_sid`) REFERENCES `applications` (`application_sid`),
  CONSTRAINT `accounts_ibfk_5` FOREIGN KEY (`queue_event_hook_sid`) REFERENCES `webhooks` (`webhook_sid`),
  CONSTRAINT `device_calling_application_sid_idxfk` FOREIGN KEY (`device_calling_application_sid`) REFERENCES `applications` (`application_sid`),
  CONSTRAINT `registration_hook_sid_idxfk_1` FOREIGN KEY (`registration_hook_sid`) REFERENCES `webhooks` (`webhook_sid`),
  CONSTRAINT `service_provider_sid_idxfk_6` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COMMENT='An enterprise that uses the platform for comm services';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `accounts`
--

LOCK TABLES `accounts` WRITE;
/*!40000 ALTER TABLE `accounts` DISABLE KEYS */;
INSERT INTO `accounts` VALUES ('622f62e4-303a-49f2-bbe0-eb1e1714e37a','Dave Horton','delta.yakeeda.com','2708b1b3-2736-40ea-b502-c53d8396247f',NULL,NULL,NULL,0,'2021-04-03 15:41:03','trial',NULL,'wh_secret_ehV2dVyzNBs5kHxeJcatRQ',0,NULL,NULL,5,NULL,NULL,NULL,NULL,NULL),('bb845d4b-83a9-4cde-a6e9-50f3743bab3f','Joe User','test.yakeeda.com','2708b1b3-2736-40ea-b502-c53d8396247f',NULL,NULL,NULL,1,'2021-04-03 15:41:03','trial',NULL,'wh_secret_ehV2dVyzNBs5kHxeJcatRQ',0,NULL,NULL,5,NULL,NULL,NULL,NULL,NULL);
/*!40000 ALTER TABLE `accounts` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `api_keys`
--

DROP TABLE IF EXISTS `api_keys`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `api_keys` (
  `api_key_sid` char(36) NOT NULL,
  `token` char(36) NOT NULL,
  `account_sid` char(36) DEFAULT NULL,
  `service_provider_sid` char(36) DEFAULT NULL,
  `expires_at` timestamp NULL DEFAULT NULL,
  `last_used` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`api_key_sid`),
  UNIQUE KEY `api_key_sid` (`api_key_sid`),
  UNIQUE KEY `token` (`token`),
  KEY `api_key_sid_idx` (`api_key_sid`),
  KEY `account_sid_idx` (`account_sid`),
  KEY `service_provider_sid_idx` (`service_provider_sid`),
  CONSTRAINT `account_sid_idxfk_4` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `api_keys_ibfk_1` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `api_keys_ibfk_2` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`),
  CONSTRAINT `service_provider_sid_idxfk` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COMMENT='An authorization token that is used to access the REST api';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `api_keys`
--

LOCK TABLES `api_keys` WRITE;
/*!40000 ALTER TABLE `api_keys` DISABLE KEYS */;
INSERT INTO `api_keys` VALUES ('3f35518f-5a0d-4c2e-90a5-2407bb3b36f0','38700987-c7a4-4685-a5bb-af378f9734de',NULL,NULL,NULL,NULL,'2021-04-03 15:40:37'),('b00b1025-2b65-453b-a243-599b75be7d0a','52c2eb45-9f72-4545-9c60-9639e3f4eaf7','bb845d4b-83a9-4cde-a6e9-50f3743bab3f',NULL,NULL,NULL,'2021-04-03 15:42:40');
/*!40000 ALTER TABLE `api_keys` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `applications`
--

DROP TABLE IF EXISTS `applications`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `applications` (
  `application_sid` char(36) NOT NULL,
  `name` varchar(64) NOT NULL,
  `service_provider_sid` char(36) DEFAULT NULL COMMENT 'if non-null, this application is a test application that can be used by any account under the associated service provider',
  `account_sid` char(36) DEFAULT NULL COMMENT 'account that this application belongs to (if null, this is a service provider test application)',
  `call_hook_sid` char(36) DEFAULT NULL COMMENT 'webhook to call for inbound calls ',
  `call_status_hook_sid` char(36) DEFAULT NULL COMMENT 'webhook to call for call status events',
  `messaging_hook_sid` char(36) DEFAULT NULL COMMENT 'webhook to call for inbound SMS/MMS ',
  `app_json` varchar(16384) DEFAULT NULL,
  `speech_synthesis_vendor` varchar(64) NOT NULL DEFAULT 'google',
  `speech_synthesis_language` varchar(12) NOT NULL DEFAULT 'en-US',
  `speech_synthesis_voice` varchar(64) DEFAULT NULL,
  `speech_recognizer_vendor` varchar(64) NOT NULL DEFAULT 'google',
  `speech_recognizer_language` varchar(64) NOT NULL DEFAULT 'en-US',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`application_sid`),
  UNIQUE KEY `application_sid` (`application_sid`),
  UNIQUE KEY `applications_idx_name` (`account_sid`,`name`),
  KEY `application_sid_idx` (`application_sid`),
  KEY `service_provider_sid_idx` (`service_provider_sid`),
  KEY `account_sid_idx` (`account_sid`),
  KEY `call_hook_sid_idxfk` (`call_hook_sid`),
  KEY `call_status_hook_sid_idxfk` (`call_status_hook_sid`),
  KEY `messaging_hook_sid_idxfk` (`messaging_hook_sid`),
  CONSTRAINT `account_sid_idxfk_10` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `applications_ibfk_1` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`),
  CONSTRAINT `applications_ibfk_2` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `applications_ibfk_3` FOREIGN KEY (`call_hook_sid`) REFERENCES `webhooks` (`webhook_sid`),
  CONSTRAINT `applications_ibfk_4` FOREIGN KEY (`call_status_hook_sid`) REFERENCES `webhooks` (`webhook_sid`),
  CONSTRAINT `applications_ibfk_5` FOREIGN KEY (`messaging_hook_sid`) REFERENCES `webhooks` (`webhook_sid`),
  CONSTRAINT `call_hook_sid_idxfk` FOREIGN KEY (`call_hook_sid`) REFERENCES `webhooks` (`webhook_sid`),
  CONSTRAINT `call_status_hook_sid_idxfk` FOREIGN KEY (`call_status_hook_sid`) REFERENCES `webhooks` (`webhook_sid`),
  CONSTRAINT `messaging_hook_sid_idxfk` FOREIGN KEY (`messaging_hook_sid`) REFERENCES `webhooks` (`webhook_sid`),
  CONSTRAINT `service_provider_sid_idxfk_5` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COMMENT='A defined set of behaviors to be applied to phone calls ';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `applications`
--

LOCK TABLES `applications` WRITE;
/*!40000 ALTER TABLE `applications` DISABLE KEYS */;
INSERT INTO `applications` VALUES ('0dddaabf-0a30-43e3-84e8-426873b1a78b','decline call',NULL,'bb845d4b-83a9-4cde-a6e9-50f3743bab3f','c71e79db-24f2-4866-a3ee-febb0f97b341','293904c1-351b-4bca-8d58-1a29b853c7db',NULL,NULL,'google','en-US','en-US-Standard-C','google','en-US','2023-05-31 03:52:48'),('0dddaabf-0a30-43e3-84e8-426873b1a78c','app json',NULL,'bb845d4b-83a9-4cde-a6e9-50f3743bab3f','c71e79db-24f2-4866-a3ee-febb0f97b341','293904c1-351b-4bca-8d58-1a29b853c7db',NULL,'[{\"verb\": \"play\",\"url\": \"silence_stream://5000\"}]','google','en-US','en-US-Standard-C','google','en-US','2023-05-31 03:52:48'),('17461c69-56b5-4dab-ad83-1c43a0f93a3d','gather',NULL,'bb845d4b-83a9-4cde-a6e9-50f3743bab3f','10692465-a511-4277-9807-b7157e4f81e1','293904c1-351b-4bca-8d58-1a29b853c7db',NULL,NULL,'google','en-US','en-US-Standard-C','google','en-US','2023-05-31 03:52:48'),('195d9507-6a42-46a8-825f-f009e729d023','sip info',NULL,'bb845d4b-83a9-4cde-a6e9-50f3743bab3f','c9113e7a-741f-48b9-96c1-f2f78176eeb3','293904c1-351b-4bca-8d58-1a29b853c7db',NULL,NULL,'google','en-US','en-US-Standard-C','google','en-US','2023-05-31 03:52:48'),('24d0f6af-e976-44dd-a2e8-41c7b55abe33','say account 2',NULL,'622f62e4-303a-49f2-bbe0-eb1e1714e37a','54ab0976-a6c0-45d8-89a4-d90d45bf9d96','293904c1-351b-4bca-8d58-1a29b853c7db',NULL,NULL,'google','en-US','en-US-Standard-C','google','en-US','2023-05-31 03:52:48'),('308b4f41-1a18-4052-b89a-c054e75ce242','say',NULL,'bb845d4b-83a9-4cde-a6e9-50f3743bab3f','54ab0976-a6c0-45d8-89a4-d90d45bf9d96','293904c1-351b-4bca-8d58-1a29b853c7db',NULL,NULL,'google','en-US','en-US-Standard-C','google','en-US','2023-05-31 03:52:48'),('ae026ab5-3029-47b4-9d7c-236e3a4b4ebe','transcribe account 2',NULL,'622f62e4-303a-49f2-bbe0-eb1e1714e37a','ecb67a8f-f7ce-4919-abf0-bbc69c1001e5','293904c1-351b-4bca-8d58-1a29b853c7db',NULL,NULL,'google','en-US','en-US-Standard-C','google','en-US','2023-05-31 03:52:48'),('baf9213b-5556-4c20-870c-586392ed246f','transcribe',NULL,'bb845d4b-83a9-4cde-a6e9-50f3743bab3f','ecb67a8f-f7ce-4919-abf0-bbc69c1001e5','293904c1-351b-4bca-8d58-1a29b853c7db',NULL,NULL,'google','en-US','en-US-Standard-C','google','en-US','2023-05-31 03:52:48');
/*!40000 ALTER TABLE `applications` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `beta_invite_codes`
--

DROP TABLE IF EXISTS `beta_invite_codes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `beta_invite_codes` (
  `invite_code` char(6) NOT NULL,
  `in_use` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`invite_code`),
  UNIQUE KEY `invite_code` (`invite_code`),
  KEY `invite_code_idx` (`invite_code`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `beta_invite_codes`
--

LOCK TABLES `beta_invite_codes` WRITE;
/*!40000 ALTER TABLE `beta_invite_codes` DISABLE KEYS */;
/*!40000 ALTER TABLE `beta_invite_codes` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `call_routes`
--

DROP TABLE IF EXISTS `call_routes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `call_routes` (
  `call_route_sid` char(36) NOT NULL,
  `priority` int(11) NOT NULL,
  `account_sid` char(36) NOT NULL,
  `regex` varchar(255) NOT NULL,
  `application_sid` char(36) NOT NULL,
  PRIMARY KEY (`call_route_sid`),
  UNIQUE KEY `call_route_sid` (`call_route_sid`),
  KEY `call_route_sid_idx` (`call_route_sid`),
  KEY `account_sid_idxfk_1` (`account_sid`),
  KEY `application_sid_idxfk` (`application_sid`),
  CONSTRAINT `account_sid_idxfk_1` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `application_sid_idxfk` FOREIGN KEY (`application_sid`) REFERENCES `applications` (`application_sid`),
  CONSTRAINT `call_routes_ibfk_1` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `call_routes_ibfk_2` FOREIGN KEY (`application_sid`) REFERENCES `applications` (`application_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COMMENT='a regex-based pattern match for call routing';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `call_routes`
--

LOCK TABLES `call_routes` WRITE;
/*!40000 ALTER TABLE `call_routes` DISABLE KEYS */;
/*!40000 ALTER TABLE `call_routes` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `dns_records`
--

DROP TABLE IF EXISTS `dns_records`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `dns_records` (
  `dns_record_sid` char(36) NOT NULL,
  `account_sid` char(36) NOT NULL,
  `record_type` varchar(6) NOT NULL,
  `record_id` int(11) NOT NULL,
  PRIMARY KEY (`dns_record_sid`),
  UNIQUE KEY `dns_record_sid` (`dns_record_sid`),
  KEY `dns_record_sid_idx` (`dns_record_sid`),
  KEY `account_sid_idxfk_2` (`account_sid`),
  CONSTRAINT `account_sid_idxfk_2` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `dns_records_ibfk_1` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `dns_records`
--

LOCK TABLES `dns_records` WRITE;
/*!40000 ALTER TABLE `dns_records` DISABLE KEYS */;
/*!40000 ALTER TABLE `dns_records` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `lcr`
--

DROP TABLE IF EXISTS `lcr`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `lcr` (
  `lcr_sid` char(36) NOT NULL,
  `name` varchar(64) DEFAULT NULL COMMENT 'User-assigned name for this LCR table',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `default_carrier_set_entry_sid` char(36) DEFAULT NULL COMMENT 'default carrier/route to use when no digit match based results are found.',
  `service_provider_sid` char(36) DEFAULT NULL,
  `account_sid` char(36) DEFAULT NULL,
  PRIMARY KEY (`lcr_sid`),
  UNIQUE KEY `lcr_sid` (`lcr_sid`),
  KEY `lcr_sid_idx` (`lcr_sid`),
  KEY `default_carrier_set_entry_sid_idxfk` (`default_carrier_set_entry_sid`),
  KEY `service_provider_sid_idx` (`service_provider_sid`),
  KEY `account_sid_idx` (`account_sid`),
  CONSTRAINT `lcr_ibfk_1` FOREIGN KEY (`default_carrier_set_entry_sid`) REFERENCES `lcr_carrier_set_entry` (`lcr_carrier_set_entry_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COMMENT='An LCR (least cost routing) table that is used by a service provider or account to make decisions about routing outbound calls when multiple carriers are available.';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `lcr`
--

LOCK TABLES `lcr` WRITE;
/*!40000 ALTER TABLE `lcr` DISABLE KEYS */;
/*!40000 ALTER TABLE `lcr` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `lcr_carrier_set_entry`
--

DROP TABLE IF EXISTS `lcr_carrier_set_entry`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `lcr_carrier_set_entry` (
  `lcr_carrier_set_entry_sid` char(36) NOT NULL,
  `workload` int(11) NOT NULL DEFAULT '1' COMMENT 'represents a proportion of traffic to send through the associated carrier; can be used for load balancing traffic across carriers with a common priority for a destination',
  `lcr_route_sid` char(36) NOT NULL,
  `voip_carrier_sid` char(36) NOT NULL,
  `priority` int(11) NOT NULL DEFAULT '0' COMMENT 'lower priority carriers are attempted first',
  PRIMARY KEY (`lcr_carrier_set_entry_sid`),
  KEY `lcr_route_sid_idxfk` (`lcr_route_sid`),
  KEY `voip_carrier_sid_idxfk_2` (`voip_carrier_sid`),
  CONSTRAINT `lcr_carrier_set_entry_ibfk_1` FOREIGN KEY (`lcr_route_sid`) REFERENCES `lcr_routes` (`lcr_route_sid`),
  CONSTRAINT `lcr_carrier_set_entry_ibfk_2` FOREIGN KEY (`voip_carrier_sid`) REFERENCES `voip_carriers` (`voip_carrier_sid`),
  CONSTRAINT `lcr_route_sid_idxfk` FOREIGN KEY (`lcr_route_sid`) REFERENCES `lcr_routes` (`lcr_route_sid`),
  CONSTRAINT `voip_carrier_sid_idxfk_2` FOREIGN KEY (`voip_carrier_sid`) REFERENCES `voip_carriers` (`voip_carrier_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COMMENT='An entry in the LCR routing list';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `lcr_carrier_set_entry`
--

LOCK TABLES `lcr_carrier_set_entry` WRITE;
/*!40000 ALTER TABLE `lcr_carrier_set_entry` DISABLE KEYS */;
/*!40000 ALTER TABLE `lcr_carrier_set_entry` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `lcr_routes`
--

DROP TABLE IF EXISTS `lcr_routes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `lcr_routes` (
  `lcr_route_sid` char(36) NOT NULL,
  `regex` varchar(32) NOT NULL COMMENT 'regex-based pattern match against dialed number, used for LCR routing of PSTN calls',
  `description` varchar(1024) DEFAULT NULL,
  `priority` int(11) NOT NULL COMMENT 'lower priority routes are attempted first',
  `lcr_sid` char(36) NOT NULL,
  PRIMARY KEY (`lcr_route_sid`),
  UNIQUE KEY `priority` (`priority`),
  KEY `lcr_sid_idx` (`lcr_sid`),
  CONSTRAINT `lcr_routes_ibfk_1` FOREIGN KEY (`lcr_sid`) REFERENCES `lcr` (`lcr_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COMMENT='Least cost routing table';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `lcr_routes`
--

LOCK TABLES `lcr_routes` WRITE;
/*!40000 ALTER TABLE `lcr_routes` DISABLE KEYS */;
/*!40000 ALTER TABLE `lcr_routes` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `ms_teams_tenants`
--

DROP TABLE IF EXISTS `ms_teams_tenants`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `ms_teams_tenants` (
  `ms_teams_tenant_sid` char(36) NOT NULL,
  `service_provider_sid` char(36) NOT NULL,
  `account_sid` char(36) NOT NULL,
  `application_sid` char(36) DEFAULT NULL,
  `tenant_fqdn` varchar(255) NOT NULL,
  PRIMARY KEY (`ms_teams_tenant_sid`),
  UNIQUE KEY `ms_teams_tenant_sid` (`ms_teams_tenant_sid`),
  UNIQUE KEY `tenant_fqdn` (`tenant_fqdn`),
  KEY `ms_teams_tenant_sid_idx` (`ms_teams_tenant_sid`),
  KEY `service_provider_sid_idxfk_1` (`service_provider_sid`),
  KEY `account_sid_idxfk_5` (`account_sid`),
  KEY `application_sid_idxfk_1` (`application_sid`),
  KEY `tenant_fqdn_idx` (`tenant_fqdn`),
  CONSTRAINT `account_sid_idxfk_5` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `application_sid_idxfk_1` FOREIGN KEY (`application_sid`) REFERENCES `applications` (`application_sid`),
  CONSTRAINT `ms_teams_tenants_ibfk_1` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`),
  CONSTRAINT `ms_teams_tenants_ibfk_2` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `ms_teams_tenants_ibfk_3` FOREIGN KEY (`application_sid`) REFERENCES `applications` (`application_sid`),
  CONSTRAINT `service_provider_sid_idxfk_1` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COMMENT='A Microsoft Teams customer tenant';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `ms_teams_tenants`
--

LOCK TABLES `ms_teams_tenants` WRITE;
/*!40000 ALTER TABLE `ms_teams_tenants` DISABLE KEYS */;
/*!40000 ALTER TABLE `ms_teams_tenants` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `password_settings`
--

DROP TABLE IF EXISTS `password_settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `password_settings` (
  `min_password_length` int(11) NOT NULL DEFAULT '8',
  `require_digit` tinyint(1) NOT NULL DEFAULT '0',
  `require_special_character` tinyint(1) NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `password_settings`
--

LOCK TABLES `password_settings` WRITE;
/*!40000 ALTER TABLE `password_settings` DISABLE KEYS */;
/*!40000 ALTER TABLE `password_settings` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `permissions`
--

DROP TABLE IF EXISTS `permissions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `permissions` (
  `permission_sid` char(36) NOT NULL,
  `name` varchar(32) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`permission_sid`),
  UNIQUE KEY `permission_sid` (`permission_sid`),
  UNIQUE KEY `name` (`name`),
  KEY `permission_sid_idx` (`permission_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `permissions`
--

LOCK TABLES `permissions` WRITE;
/*!40000 ALTER TABLE `permissions` DISABLE KEYS */;
/*!40000 ALTER TABLE `permissions` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `phone_numbers`
--

DROP TABLE IF EXISTS `phone_numbers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `phone_numbers` (
  `phone_number_sid` char(36) NOT NULL,
  `number` varchar(32) NOT NULL,
  `voip_carrier_sid` char(36) DEFAULT NULL,
  `account_sid` char(36) DEFAULT NULL,
  `application_sid` char(36) DEFAULT NULL,
  `service_provider_sid` char(36) DEFAULT NULL COMMENT 'if not null, this number is a test number for the associated service provider',
  PRIMARY KEY (`phone_number_sid`),
  UNIQUE KEY `number` (`number`),
  UNIQUE KEY `phone_number_sid` (`phone_number_sid`),
  KEY `phone_number_sid_idx` (`phone_number_sid`),
  KEY `number_idx` (`number`),
  KEY `voip_carrier_sid_idx` (`voip_carrier_sid`),
  KEY `account_sid_idxfk_9` (`account_sid`),
  KEY `application_sid_idxfk_3` (`application_sid`),
  KEY `service_provider_sid_idx` (`service_provider_sid`),
  CONSTRAINT `account_sid_idxfk_9` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `application_sid_idxfk_3` FOREIGN KEY (`application_sid`) REFERENCES `applications` (`application_sid`),
  CONSTRAINT `phone_numbers_ibfk_1` FOREIGN KEY (`voip_carrier_sid`) REFERENCES `voip_carriers` (`voip_carrier_sid`),
  CONSTRAINT `phone_numbers_ibfk_2` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `phone_numbers_ibfk_3` FOREIGN KEY (`application_sid`) REFERENCES `applications` (`application_sid`),
  CONSTRAINT `phone_numbers_ibfk_4` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`),
  CONSTRAINT `service_provider_sid_idxfk_4` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`),
  CONSTRAINT `voip_carrier_sid_idxfk` FOREIGN KEY (`voip_carrier_sid`) REFERENCES `voip_carriers` (`voip_carrier_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COMMENT='A phone number that has been assigned to an account';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `phone_numbers`
--

LOCK TABLES `phone_numbers` WRITE;
/*!40000 ALTER TABLE `phone_numbers` DISABLE KEYS */;
INSERT INTO `phone_numbers` VALUES ('05eeed62-b29b-4679-bf38-d7a4e318be44','16174000003','5145b436-2f38-4029-8d4c-fd8c67831c7a','bb845d4b-83a9-4cde-a6e9-50f3743bab3f','17461c69-56b5-4dab-ad83-1c43a0f93a3d',NULL),('4b439355-debc-40c7-9cfa-5be58c2bed6b','16174000000','5145b436-2f38-4029-8d4c-fd8c67831c7a','bb845d4b-83a9-4cde-a6e9-50f3743bab3f','0dddaabf-0a30-43e3-84e8-426873b1a78b',NULL),('964d0581-9627-44cb-be20-8118050406b2','16174000006','5145b436-2f38-4029-8d4c-fd8c67831c7a','bb845d4b-83a9-4cde-a6e9-50f3743bab3f','195d9507-6a42-46a8-825f-f009e729d023',NULL),('964d0581-9627-44cb-be20-8118050406b3','16174000007','5145b436-2f38-4029-8d4c-fd8c67831c7a','bb845d4b-83a9-4cde-a6e9-50f3743bab3f','0dddaabf-0a30-43e3-84e8-426873b1a78c',NULL),('9cc9e7fc-b7b0-4101-8f3c-9fe13ce5df0a','16174000001','5145b436-2f38-4029-8d4c-fd8c67831c7a','bb845d4b-83a9-4cde-a6e9-50f3743bab3f','308b4f41-1a18-4052-b89a-c054e75ce242',NULL),('e686a320-0725-418f-be65-532159bdc3ed','16174000002','5145b436-2f38-4029-8d4c-fd8c67831c7a','622f62e4-303a-49f2-bbe0-eb1e1714e37a','24d0f6af-e976-44dd-a2e8-41c7b55abe33',NULL),('f3c53863-b629-4cf6-9dcb-c7fb7072314b','16174000004','5145b436-2f38-4029-8d4c-fd8c67831c7a','bb845d4b-83a9-4cde-a6e9-50f3743bab3f','baf9213b-5556-4c20-870c-586392ed246f',NULL),('f6416c17-829a-4f11-9c32-f0d00e4a9ae9','16174000005','5145b436-2f38-4029-8d4c-fd8c67831c7a','622f62e4-303a-49f2-bbe0-eb1e1714e37a','ae026ab5-3029-47b4-9d7c-236e3a4b4ebe',NULL);
/*!40000 ALTER TABLE `phone_numbers` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `predefined_carriers`
--

DROP TABLE IF EXISTS `predefined_carriers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `predefined_carriers` (
  `predefined_carrier_sid` char(36) NOT NULL,
  `name` varchar(64) NOT NULL,
  `requires_static_ip` tinyint(1) NOT NULL DEFAULT '0',
  `e164_leading_plus` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'if true, a leading plus should be prepended to outbound phone numbers',
  `requires_register` tinyint(1) NOT NULL DEFAULT '0',
  `register_username` varchar(64) DEFAULT NULL,
  `register_sip_realm` varchar(64) DEFAULT NULL,
  `register_password` varchar(64) DEFAULT NULL,
  `tech_prefix` varchar(16) DEFAULT NULL COMMENT 'tech prefix to prepend to outbound calls to this carrier',
  `inbound_auth_username` varchar(64) DEFAULT NULL,
  `inbound_auth_password` varchar(64) DEFAULT NULL,
  `diversion` varchar(32) DEFAULT NULL,
  PRIMARY KEY (`predefined_carrier_sid`),
  UNIQUE KEY `predefined_carrier_sid` (`predefined_carrier_sid`),
  KEY `predefined_carrier_sid_idx` (`predefined_carrier_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `predefined_carriers`
--

LOCK TABLES `predefined_carriers` WRITE;
/*!40000 ALTER TABLE `predefined_carriers` DISABLE KEYS */;
/*!40000 ALTER TABLE `predefined_carriers` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `predefined_sip_gateways`
--

DROP TABLE IF EXISTS `predefined_sip_gateways`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `predefined_sip_gateways` (
  `predefined_sip_gateway_sid` char(36) NOT NULL,
  `ipv4` varchar(128) NOT NULL COMMENT 'ip address or DNS name of the gateway.  For gateways providing inbound calling service, ip address is required.',
  `port` int(11) NOT NULL DEFAULT '5060' COMMENT 'sip signaling port',
  `inbound` tinyint(1) NOT NULL COMMENT 'if true, whitelist this IP to allow inbound calls from the gateway',
  `outbound` tinyint(1) NOT NULL COMMENT 'if true, include in least-cost routing when placing calls to the PSTN',
  `netmask` int(11) NOT NULL DEFAULT '32',
  `predefined_carrier_sid` char(36) NOT NULL,
  PRIMARY KEY (`predefined_sip_gateway_sid`),
  UNIQUE KEY `predefined_sip_gateway_sid` (`predefined_sip_gateway_sid`),
  KEY `predefined_sip_gateway_sid_idx` (`predefined_sip_gateway_sid`),
  KEY `predefined_carrier_sid_idx` (`predefined_carrier_sid`),
  CONSTRAINT `predefined_sip_gateways_ibfk_1` FOREIGN KEY (`predefined_carrier_sid`) REFERENCES `predefined_carriers` (`predefined_carrier_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `predefined_sip_gateways`
--

LOCK TABLES `predefined_sip_gateways` WRITE;
/*!40000 ALTER TABLE `predefined_sip_gateways` DISABLE KEYS */;
/*!40000 ALTER TABLE `predefined_sip_gateways` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `predefined_smpp_gateways`
--

DROP TABLE IF EXISTS `predefined_smpp_gateways`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `predefined_smpp_gateways` (
  `predefined_smpp_gateway_sid` char(36) NOT NULL,
  `ipv4` varchar(128) NOT NULL COMMENT 'ip address or DNS name of the gateway. ',
  `port` int(11) NOT NULL DEFAULT '2775' COMMENT 'smpp signaling port',
  `inbound` tinyint(1) NOT NULL COMMENT 'if true, whitelist this IP to allow inbound SMS from the gateway',
  `outbound` tinyint(1) NOT NULL COMMENT 'i',
  `netmask` int(11) NOT NULL DEFAULT '32',
  `is_primary` tinyint(1) NOT NULL DEFAULT '1',
  `use_tls` tinyint(1) DEFAULT '0',
  `predefined_carrier_sid` char(36) NOT NULL,
  PRIMARY KEY (`predefined_smpp_gateway_sid`),
  UNIQUE KEY `predefined_smpp_gateway_sid` (`predefined_smpp_gateway_sid`),
  KEY `predefined_smpp_gateway_sid_idx` (`predefined_smpp_gateway_sid`),
  KEY `predefined_carrier_sid_idx` (`predefined_carrier_sid`),
  CONSTRAINT `predefined_smpp_gateways_ibfk_1` FOREIGN KEY (`predefined_carrier_sid`) REFERENCES `predefined_carriers` (`predefined_carrier_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `predefined_smpp_gateways`
--

LOCK TABLES `predefined_smpp_gateways` WRITE;
/*!40000 ALTER TABLE `predefined_smpp_gateways` DISABLE KEYS */;
/*!40000 ALTER TABLE `predefined_smpp_gateways` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `products`
--

DROP TABLE IF EXISTS `products`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `products` (
  `product_sid` char(36) NOT NULL,
  `name` varchar(32) NOT NULL,
  `category` enum('api_rate','voice_call_session','device') NOT NULL,
  PRIMARY KEY (`product_sid`),
  UNIQUE KEY `product_sid` (`product_sid`),
  KEY `product_sid_idx` (`product_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `products`
--

LOCK TABLES `products` WRITE;
/*!40000 ALTER TABLE `products` DISABLE KEYS */;
INSERT INTO `products` VALUES ('2c815913-5c26-4004-b748-183b459329df','registered device','device'),('35a9fb10-233d-4eb9-aada-78de5814d680','api call','api_rate'),('c4403cdb-8e75-4b27-9726-7d8315e3216d','concurrent call session','voice_call_session');
/*!40000 ALTER TABLE `products` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `sbc_addresses`
--

DROP TABLE IF EXISTS `sbc_addresses`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `sbc_addresses` (
  `sbc_address_sid` char(36) NOT NULL,
  `ipv4` varchar(255) NOT NULL,
  `port` int(11) NOT NULL DEFAULT '5060',
  `service_provider_sid` char(36) DEFAULT NULL,
  `tls_port` int(11) DEFAULT NULL,
  `wss_port` int(11) DEFAULT NULL,
  `last_updated` datetime DEFAULT NULL,
  PRIMARY KEY (`sbc_address_sid`),
  UNIQUE KEY `sbc_address_sid` (`sbc_address_sid`),
  KEY `sbc_addresses_idx_host_port` (`ipv4`,`port`),
  KEY `sbc_address_sid_idx` (`sbc_address_sid`),
  KEY `service_provider_sid_idx` (`service_provider_sid`),
  CONSTRAINT `sbc_addresses_ibfk_1` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`),
  CONSTRAINT `service_provider_sid_idxfk_2` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `sbc_addresses`
--

LOCK TABLES `sbc_addresses` WRITE;
/*!40000 ALTER TABLE `sbc_addresses` DISABLE KEYS */;
INSERT INTO `sbc_addresses` VALUES ('8d6d0fda-4550-41ab-8e2f-60761d81fe7d','3.39.45.30',5060,NULL,NULL,NULL,NULL);
/*!40000 ALTER TABLE `sbc_addresses` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `schema_version`
--

DROP TABLE IF EXISTS `schema_version`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `schema_version` (
  `version` varchar(16) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `schema_version`
--

LOCK TABLES `schema_version` WRITE;
/*!40000 ALTER TABLE `schema_version` DISABLE KEYS */;
INSERT INTO `schema_version` VALUES ('0.8.3');
/*!40000 ALTER TABLE `schema_version` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `service_provider_limits`
--

DROP TABLE IF EXISTS `service_provider_limits`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `service_provider_limits` (
  `service_provider_limits_sid` char(36) NOT NULL,
  `service_provider_sid` char(36) NOT NULL,
  `category` enum('api_rate','voice_call_session','device','voice_call_minutes','voice_call_session_license','voice_call_minutes_license') NOT NULL,
  `quantity` int(11) NOT NULL,
  PRIMARY KEY (`service_provider_limits_sid`),
  UNIQUE KEY `service_provider_limits_sid` (`service_provider_limits_sid`),
  KEY `service_provider_sid_idx` (`service_provider_sid`),
  CONSTRAINT `service_provider_limits_ibfk_1` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `service_provider_limits`
--

LOCK TABLES `service_provider_limits` WRITE;
/*!40000 ALTER TABLE `service_provider_limits` DISABLE KEYS */;
/*!40000 ALTER TABLE `service_provider_limits` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `service_providers`
--

DROP TABLE IF EXISTS `service_providers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `service_providers` (
  `service_provider_sid` char(36) NOT NULL,
  `name` varchar(64) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `root_domain` varchar(128) DEFAULT NULL,
  `registration_hook_sid` char(36) DEFAULT NULL,
  `ms_teams_fqdn` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`service_provider_sid`),
  UNIQUE KEY `service_provider_sid` (`service_provider_sid`),
  UNIQUE KEY `name` (`name`),
  UNIQUE KEY `root_domain` (`root_domain`),
  KEY `service_provider_sid_idx` (`service_provider_sid`),
  KEY `name_idx` (`name`),
  KEY `root_domain_idx` (`root_domain`),
  KEY `registration_hook_sid_idxfk` (`registration_hook_sid`),
  CONSTRAINT `registration_hook_sid_idxfk` FOREIGN KEY (`registration_hook_sid`) REFERENCES `webhooks` (`webhook_sid`),
  CONSTRAINT `service_providers_ibfk_1` FOREIGN KEY (`registration_hook_sid`) REFERENCES `webhooks` (`webhook_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COMMENT='A partition of the platform used by one service provider';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `service_providers`
--

LOCK TABLES `service_providers` WRITE;
/*!40000 ALTER TABLE `service_providers` DISABLE KEYS */;
INSERT INTO `service_providers` VALUES ('2708b1b3-2736-40ea-b502-c53d8396247f','jambonz.cloud','jambonz.cloud service provider','yakeeda.com',NULL,NULL);
/*!40000 ALTER TABLE `service_providers` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `signup_history`
--

DROP TABLE IF EXISTS `signup_history`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `signup_history` (
  `email` varchar(255) NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `signed_up_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`email`),
  KEY `email_idx` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `signup_history`
--

LOCK TABLES `signup_history` WRITE;
/*!40000 ALTER TABLE `signup_history` DISABLE KEYS */;
/*!40000 ALTER TABLE `signup_history` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `sip_gateways`
--

DROP TABLE IF EXISTS `sip_gateways`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `sip_gateways` (
  `sip_gateway_sid` char(36) NOT NULL,
  `ipv4` varchar(128) NOT NULL COMMENT 'ip address or DNS name of the gateway.  For gateways providing inbound calling service, ip address is required.',
  `netmask` int(11) NOT NULL DEFAULT '32',
  `port` int(11) NOT NULL DEFAULT '5060' COMMENT 'sip signaling port',
  `inbound` tinyint(1) NOT NULL COMMENT 'if true, whitelist this IP to allow inbound calls from the gateway',
  `outbound` tinyint(1) NOT NULL COMMENT 'if true, include in least-cost routing when placing calls to the PSTN',
  `voip_carrier_sid` char(36) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `protocol` enum('udp','tcp','tls','tls/srtp') DEFAULT 'udp' COMMENT 'Outbound call protocol',
  PRIMARY KEY (`sip_gateway_sid`),
  KEY `sip_gateway_idx_hostport` (`ipv4`,`port`),
  KEY `voip_carrier_sid_idx` (`voip_carrier_sid`),
  CONSTRAINT `sip_gateways_ibfk_1` FOREIGN KEY (`voip_carrier_sid`) REFERENCES `voip_carriers` (`voip_carrier_sid`),
  CONSTRAINT `voip_carrier_sid_idxfk_1` FOREIGN KEY (`voip_carrier_sid`) REFERENCES `voip_carriers` (`voip_carrier_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COMMENT='A whitelisted sip gateway used for origination/termination';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `sip_gateways`
--

LOCK TABLES `sip_gateways` WRITE;
/*!40000 ALTER TABLE `sip_gateways` DISABLE KEYS */;
INSERT INTO `sip_gateways` VALUES ('46b727eb-c7dc-44fa-b063-96e48d408e4a','3.3.3.3',32,5060,1,1,'5145b436-2f38-4029-8d4c-fd8c67831c7a',1,'udp'),('81629182-6904-4588-8c72-a78d70053fb9','54.172.60.1',32,5060,1,1,'df0aefbf-ca7b-4d48-9fbf-3c66fef72060',1,'udp');
/*!40000 ALTER TABLE `sip_gateways` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `smpp_addresses`
--

DROP TABLE IF EXISTS `smpp_addresses`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `smpp_addresses` (
  `smpp_address_sid` char(36) NOT NULL,
  `ipv4` varchar(255) NOT NULL,
  `port` int(11) NOT NULL DEFAULT '5060',
  `use_tls` tinyint(1) NOT NULL DEFAULT '0',
  `is_primary` tinyint(1) NOT NULL DEFAULT '1',
  `service_provider_sid` char(36) DEFAULT NULL,
  PRIMARY KEY (`smpp_address_sid`),
  UNIQUE KEY `smpp_address_sid` (`smpp_address_sid`),
  KEY `smpp_address_sid_idx` (`smpp_address_sid`),
  KEY `service_provider_sid_idx` (`service_provider_sid`),
  CONSTRAINT `smpp_addresses_ibfk_1` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `smpp_addresses`
--

LOCK TABLES `smpp_addresses` WRITE;
/*!40000 ALTER TABLE `smpp_addresses` DISABLE KEYS */;
/*!40000 ALTER TABLE `smpp_addresses` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `smpp_gateways`
--

DROP TABLE IF EXISTS `smpp_gateways`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `smpp_gateways` (
  `smpp_gateway_sid` char(36) NOT NULL,
  `ipv4` varchar(128) NOT NULL,
  `port` int(11) NOT NULL DEFAULT '2775',
  `netmask` int(11) NOT NULL DEFAULT '32',
  `is_primary` tinyint(1) NOT NULL DEFAULT '1',
  `inbound` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'if true, whitelist this IP to allow inbound calls from the gateway',
  `outbound` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'if true, include in least-cost routing when placing calls to the PSTN',
  `use_tls` tinyint(1) DEFAULT '0',
  `voip_carrier_sid` char(36) NOT NULL,
  PRIMARY KEY (`smpp_gateway_sid`),
  UNIQUE KEY `smpp_gateway_sid` (`smpp_gateway_sid`),
  KEY `smpp_gateway_sid_idx` (`smpp_gateway_sid`),
  KEY `voip_carrier_sid_idx` (`voip_carrier_sid`),
  CONSTRAINT `smpp_gateways_ibfk_1` FOREIGN KEY (`voip_carrier_sid`) REFERENCES `voip_carriers` (`voip_carrier_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `smpp_gateways`
--

LOCK TABLES `smpp_gateways` WRITE;
/*!40000 ALTER TABLE `smpp_gateways` DISABLE KEYS */;
/*!40000 ALTER TABLE `smpp_gateways` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `speech_credentials`
--

DROP TABLE IF EXISTS `speech_credentials`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `speech_credentials` (
  `speech_credential_sid` char(36) NOT NULL,
  `service_provider_sid` char(36) DEFAULT NULL,
  `account_sid` char(36) NOT NULL,
  `vendor` varchar(255) NOT NULL,
  `credential` varchar(8192) NOT NULL,
  `use_for_tts` tinyint(1) DEFAULT '1',
  `use_for_stt` tinyint(1) DEFAULT '1',
  `last_used` datetime DEFAULT NULL,
  `last_tested` datetime DEFAULT NULL,
  `tts_tested_ok` tinyint(1) DEFAULT NULL,
  `stt_tested_ok` tinyint(1) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `label` VARCHAR(64),
  PRIMARY KEY (`speech_credential_sid`),
  UNIQUE KEY `speech_credential_sid` (`speech_credential_sid`),
  UNIQUE KEY `speech_credentials_idx_1` (`vendor`,`account_sid`),
  KEY `speech_credential_sid_idx` (`speech_credential_sid`),
  KEY `account_sid_idx` (`account_sid`),
  KEY `service_provider_sid_idx` (`service_provider_sid`),
  CONSTRAINT `account_sid_idxfk_6` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `speech_credentials_ibfk_1` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`),
  CONSTRAINT `speech_credentials_ibfk_2` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `speech_credentials`
--

LOCK TABLES `speech_credentials` WRITE;
/*!40000 ALTER TABLE `speech_credentials` DISABLE KEYS */;
INSERT INTO `speech_credentials` VALUES ('2add163c-34f2-45c6-a016-f955d218ffb6',NULL,'bb845d4b-83a9-4cde-a6e9-50f3743bab3f','google','credential-goes-here',1,1,NULL,'2021-04-03 15:42:10',1,1,'2023-05-31 03:44:21', NULL),('2add347f-34f2-45c6-a016-f955d218ffb6',NULL,'bb845d4b-83a9-4cde-a6e9-50f3743bab3f','microsoft','credential-goes-here',1,1,NULL,'2021-04-03 15:42:10',1,1,'2023-05-31 03:44:21', NULL),('84154212-5c99-4c94-8993-bc2a46288daa',NULL,'bb845d4b-83a9-4cde-a6e9-50f3743bab3f','aws','credential-goes-here',1,1,NULL,NULL,1,1,'2023-05-31 03:44:21', NULL);
/*!40000 ALTER TABLE `speech_credentials` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `system_information`
--

DROP TABLE IF EXISTS `system_information`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `system_information` (
  `domain_name` varchar(255) DEFAULT NULL,
  `sip_domain_name` varchar(255) DEFAULT NULL,
  `monitoring_domain_name` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `system_information`
--

LOCK TABLES `system_information` WRITE;
/*!40000 ALTER TABLE `system_information` DISABLE KEYS */;
/*!40000 ALTER TABLE `system_information` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `user_permissions`
--

DROP TABLE IF EXISTS `user_permissions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `user_permissions` (
  `user_permissions_sid` char(36) NOT NULL,
  `user_sid` char(36) NOT NULL,
  `permission_sid` char(36) NOT NULL,
  PRIMARY KEY (`user_permissions_sid`),
  UNIQUE KEY `user_permissions_sid` (`user_permissions_sid`),
  KEY `user_permissions_sid_idx` (`user_permissions_sid`),
  KEY `user_sid_idx` (`user_sid`),
  KEY `permission_sid_idxfk` (`permission_sid`),
  CONSTRAINT `user_permissions_ibfk_1` FOREIGN KEY (`user_sid`) REFERENCES `users` (`user_sid`) ON DELETE CASCADE,
  CONSTRAINT `user_permissions_ibfk_2` FOREIGN KEY (`permission_sid`) REFERENCES `permissions` (`permission_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `user_permissions`
--

LOCK TABLES `user_permissions` WRITE;
/*!40000 ALTER TABLE `user_permissions` DISABLE KEYS */;
/*!40000 ALTER TABLE `user_permissions` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `users` (
  `user_sid` char(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `pending_email` varchar(255) DEFAULT NULL,
  `phone` varchar(20) DEFAULT NULL,
  `hashed_password` varchar(1024) DEFAULT NULL,
  `salt` char(16) DEFAULT NULL,
  `account_sid` char(36) DEFAULT NULL,
  `service_provider_sid` char(36) DEFAULT NULL,
  `force_change` tinyint(1) NOT NULL DEFAULT '0',
  `provider` varchar(255) NOT NULL,
  `provider_userid` varchar(255) DEFAULT NULL,
  `scope` varchar(16) NOT NULL DEFAULT 'read-write',
  `phone_activation_code` varchar(16) DEFAULT NULL,
  `email_activation_code` varchar(16) DEFAULT NULL,
  `email_validated` tinyint(1) NOT NULL DEFAULT '0',
  `phone_validated` tinyint(1) NOT NULL DEFAULT '0',
  `email_content_opt_out` tinyint(1) NOT NULL DEFAULT '0',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`user_sid`),
  UNIQUE KEY `user_sid` (`user_sid`),
  UNIQUE KEY `phone` (`phone`),
  KEY `user_sid_idx` (`user_sid`),
  KEY `email_idx` (`email`),
  KEY `phone_idx` (`phone`),
  KEY `account_sid_idx` (`account_sid`),
  KEY `service_provider_sid_idx` (`service_provider_sid`),
  KEY `email_activation_code_idx` (`email_activation_code`),
  CONSTRAINT `account_sid_idxfk_7` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `service_provider_sid_idxfk_3` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`),
  CONSTRAINT `users_ibfk_1` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `users_ibfk_2` FOREIGN KEY (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
INSERT INTO `users` VALUES ('d9cdf199-78d1-4f92-b717-5f9dbdf56565','Dave Horton','daveh@drachtio.org',NULL,NULL,NULL,NULL,'bb845d4b-83a9-4cde-a6e9-50f3743bab3f',NULL,0,'github','davehorton','read-write',NULL,NULL,1,0,0,1);
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `voip_carriers`
--

DROP TABLE IF EXISTS `voip_carriers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `voip_carriers` (
  `voip_carrier_sid` char(36) NOT NULL,
  `name` varchar(64) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `account_sid` char(36) DEFAULT NULL COMMENT 'if provided, indicates this entity represents a sip trunk that is associated with a specific account',
  `application_sid` char(36) DEFAULT NULL COMMENT 'If provided, all incoming calls from this source will be routed to the associated application',
  `e164_leading_plus` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'if true, a leading plus should be prepended to outbound phone numbers',
  `requires_register` tinyint(1) NOT NULL DEFAULT '0',
  `register_username` varchar(64) DEFAULT NULL,
  `register_sip_realm` varchar(64) DEFAULT NULL,
  `register_password` varchar(64) DEFAULT NULL,
  `tech_prefix` varchar(16) DEFAULT NULL COMMENT 'tech prefix to prepend to outbound calls to this carrier',
  `inbound_auth_username` varchar(64) DEFAULT NULL,
  `inbound_auth_password` varchar(64) DEFAULT NULL,
  `diversion` varchar(32) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `smpp_system_id` varchar(255) DEFAULT NULL,
  `smpp_password` varchar(64) DEFAULT NULL,
  `smpp_enquire_link_interval` int(11) DEFAULT '0',
  `smpp_inbound_system_id` varchar(255) DEFAULT NULL,
  `smpp_inbound_password` varchar(64) DEFAULT NULL,
  `register_from_user` varchar(128) DEFAULT NULL,
  `register_from_domain` varchar(255) DEFAULT NULL,
  `register_public_ip_in_contact` tinyint(1) NOT NULL DEFAULT '0',
  `register_status` varchar(4096) DEFAULT NULL,
  PRIMARY KEY (`voip_carrier_sid`),
  UNIQUE KEY `voip_carrier_sid` (`voip_carrier_sid`),
  KEY `voip_carrier_sid_idx` (`voip_carrier_sid`),
  KEY `account_sid_idx` (`account_sid`),
  KEY `application_sid_idxfk_2` (`application_sid`),
  CONSTRAINT `account_sid_idxfk_8` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `application_sid_idxfk_2` FOREIGN KEY (`application_sid`) REFERENCES `applications` (`application_sid`),
  CONSTRAINT `voip_carriers_ibfk_1` FOREIGN KEY (`account_sid`) REFERENCES `accounts` (`account_sid`),
  CONSTRAINT `voip_carriers_ibfk_2` FOREIGN KEY (`application_sid`) REFERENCES `applications` (`application_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COMMENT='A Carrier or customer PBX that can send or receive calls';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `voip_carriers`
--

LOCK TABLES `voip_carriers` WRITE;
/*!40000 ALTER TABLE `voip_carriers` DISABLE KEYS */;
INSERT INTO `voip_carriers` VALUES ('5145b436-2f38-4029-8d4c-fd8c67831c7a','my test carrier',NULL,NULL,NULL,0,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,'2023-05-31 03:48:04',NULL,NULL,0,NULL,NULL,NULL,NULL,0,NULL),('df0aefbf-ca7b-4d48-9fbf-3c66fef72060','my test carrier',NULL,'bb845d4b-83a9-4cde-a6e9-50f3743bab3f',NULL,0,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,'2023-05-31 03:48:04',NULL,NULL,0,NULL,NULL,NULL,NULL,0,NULL);
/*!40000 ALTER TABLE `voip_carriers` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `webhooks`
--

DROP TABLE IF EXISTS `webhooks`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `webhooks` (
  `webhook_sid` char(36) NOT NULL,
  `url` varchar(1024) NOT NULL,
  `method` enum('GET','POST') NOT NULL DEFAULT 'POST',
  `username` varchar(255) DEFAULT NULL,
  `password` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`webhook_sid`),
  UNIQUE KEY `webhook_sid` (`webhook_sid`),
  KEY `webhook_sid_idx` (`webhook_sid`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COMMENT='An HTTP callback';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `webhooks`
--

LOCK TABLES `webhooks` WRITE;
/*!40000 ALTER TABLE `webhooks` DISABLE KEYS */;
INSERT INTO `webhooks` VALUES ('10692465-a511-4277-9807-b7157e4f81e1','http://127.0.0.1:3102/','POST',NULL,NULL),('293904c1-351b-4bca-8d58-1a29b853c7db','http://127.0.0.1:3100/callStatus','POST',NULL,NULL),('54ab0976-a6c0-45d8-89a4-d90d45bf9d96','http://127.0.0.1:3101/','POST',NULL,NULL),('6ac36aeb-6bd0-428a-80a1-aed95640a296','https://flows.jambonz.cloud/callStatus','POST',NULL,NULL),('c71e79db-24f2-4866-a3ee-febb0f97b341','http://127.0.0.1:3100/','POST',NULL,NULL),('c9113e7a-741f-48b9-96c1-f2f78176eeb3','http://127.0.0.1:3104/','POST',NULL,NULL),('d9c205c6-a129-443e-a9c0-d1bb437d4bb7','https://flows.jambonz.cloud/testCall','POST',NULL,NULL),('ecb67a8f-f7ce-4919-abf0-bbc69c1001e5','http://127.0.0.1:3103/','POST',NULL,NULL);
/*!40000 ALTER TABLE `webhooks` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2023-05-31  4:01:27
