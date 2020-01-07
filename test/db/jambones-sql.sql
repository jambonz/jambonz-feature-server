/* SQLEditor (MySQL (2))*/


DROP TABLE IF EXISTS `call_routes`;

DROP TABLE IF EXISTS `conference_participants`;

DROP TABLE IF EXISTS `queue_members`;

DROP TABLE IF EXISTS `calls`;

DROP TABLE IF EXISTS `phone_numbers`;

DROP TABLE IF EXISTS `applications`;

DROP TABLE IF EXISTS `conferences`;

DROP TABLE IF EXISTS `queues`;

DROP TABLE IF EXISTS `subscriptions`;

DROP TABLE IF EXISTS `registrations`;

DROP TABLE IF EXISTS `api_keys`;

DROP TABLE IF EXISTS `accounts`;

DROP TABLE IF EXISTS `service_providers`;

DROP TABLE IF EXISTS `sip_gateways`;

DROP TABLE IF EXISTS `voip_carriers`;

CREATE TABLE IF NOT EXISTS `applications`
(
`application_sid` CHAR(36) NOT NULL UNIQUE ,
`name` VARCHAR(255) NOT NULL,
`account_sid` CHAR(36) NOT NULL,
`call_hook` VARCHAR(255) NOT NULL,
`call_status_hook` VARCHAR(255) NOT NULL,
PRIMARY KEY (`application_sid`)
) ENGINE=InnoDB COMMENT='A defined set of behaviors to be applied to phone calls with';

CREATE TABLE IF NOT EXISTS `call_routes`
(
`call_route_sid` CHAR(36) NOT NULL UNIQUE ,
`order` INTEGER NOT NULL,
`account_sid` CHAR(36) NOT NULL,
`regex` VARCHAR(255) NOT NULL,
`application_sid` CHAR(36) NOT NULL,
PRIMARY KEY (`call_route_sid`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `conferences`
(
`id` INTEGER(10) UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE ,
`conference_sid` CHAR(36) NOT NULL UNIQUE ,
`name` VARCHAR(255),
PRIMARY KEY (`id`)
) ENGINE=InnoDB COMMENT='An audio conference';

CREATE TABLE IF NOT EXISTS `conference_participants`
(
`conference_participant_sid` CHAR(36) NOT NULL UNIQUE ,
`call_sid` CHAR(36),
`conference_sid` CHAR(36) NOT NULL,
PRIMARY KEY (`conference_participant_sid`)
) ENGINE=InnoDB COMMENT='A relationship between a call and a conference that it is co';

CREATE TABLE IF NOT EXISTS `queues`
(
`id` INTEGER(10) UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE ,
`queue_sid` CHAR(36) NOT NULL UNIQUE ,
`name` VARCHAR(255),
PRIMARY KEY (`id`)
) ENGINE=InnoDB COMMENT='A set of behaviors to be applied to parked calls';

CREATE TABLE IF NOT EXISTS `registrations`
(
`registration_sid` CHAR(36) NOT NULL UNIQUE ,
`username` VARCHAR(255) NOT NULL,
`domain` VARCHAR(255) NOT NULL,
`sip_contact` VARCHAR(255) NOT NULL,
`sip_user_agent` VARCHAR(255),
PRIMARY KEY (`registration_sid`)
) ENGINE=InnoDB COMMENT='An active sip registration';

CREATE TABLE IF NOT EXISTS `queue_members`
(
`queue_member_sid` CHAR(36) NOT NULL UNIQUE ,
`call_sid` CHAR(36),
`queue_sid` CHAR(36) NOT NULL,
`position` INTEGER,
PRIMARY KEY (`queue_member_sid`)
) ENGINE=InnoDB COMMENT='A relationship between a call and a queue that it is waiting';

CREATE TABLE IF NOT EXISTS `calls`
(
`call_sid` CHAR(36) NOT NULL UNIQUE ,
`parent_call_sid` CHAR(36),
`application_sid` CHAR(36),
`status_url` VARCHAR(255),
`time_start` DATETIME NOT NULL,
`time_alerting` DATETIME,
`time_answered` DATETIME,
`time_ended` DATETIME,
`direction` ENUM('inbound','outbound'),
`phone_number_sid` CHAR(36),
`inbound_user_sid` CHAR(36),
`outbound_user_sid` CHAR(36),
`calling_number` VARCHAR(255),
`called_number` VARCHAR(255),
`caller_name` VARCHAR(255),
`status` VARCHAR(255) NOT NULL COMMENT 'Possible values are queued, ringing, in-progress, completed, failed, busy and no-answer',
`sip_uri` VARCHAR(255) NOT NULL,
`sip_call_id` VARCHAR(255) NOT NULL,
`sip_cseq` INTEGER NOT NULL,
`sip_from_tag` VARCHAR(255) NOT NULL,
`sip_via_branch` VARCHAR(255) NOT NULL,
`sip_contact` VARCHAR(255),
`sip_final_status` INTEGER UNSIGNED,
`sdp_offer` VARCHAR(4096),
`sdp_answer` VARCHAR(4096),
`source_address` VARCHAR(255) NOT NULL,
`source_port` INTEGER UNSIGNED NOT NULL,
`dest_address` VARCHAR(255),
`dest_port` INTEGER UNSIGNED,
`url` VARCHAR(255),
PRIMARY KEY (`call_sid`)
) ENGINE=InnoDB COMMENT='A phone call';

CREATE TABLE IF NOT EXISTS `service_providers`
(
`service_provider_sid` CHAR(36) NOT NULL UNIQUE ,
`name` VARCHAR(255) NOT NULL UNIQUE ,
`description` VARCHAR(255),
`root_domain` VARCHAR(255) UNIQUE ,
`registration_hook` VARCHAR(255),
`hook_basic_auth_user` VARCHAR(255),
`hook_basic_auth_password` VARCHAR(255),
PRIMARY KEY (`service_provider_sid`)
) ENGINE=InnoDB COMMENT='An organization that provides communication services to its ';

CREATE TABLE IF NOT EXISTS `api_keys`
(
`api_key_sid` CHAR(36) NOT NULL UNIQUE ,
`token` CHAR(36) NOT NULL UNIQUE ,
`account_sid` CHAR(36),
`service_provider_sid` CHAR(36),
PRIMARY KEY (`api_key_sid`)
) ENGINE=InnoDB COMMENT='An authorization token that is used to access the REST api';

CREATE TABLE IF NOT EXISTS `accounts`
(
`account_sid` CHAR(36) NOT NULL UNIQUE ,
`name` VARCHAR(255) NOT NULL,
`sip_realm` VARCHAR(255) UNIQUE ,
`service_provider_sid` CHAR(36) NOT NULL,
`registration_hook` VARCHAR(255),
`hook_basic_auth_user` VARCHAR(255),
`hook_basic_auth_password` VARCHAR(255),
`is_active` BOOLEAN NOT NULL DEFAULT true,
PRIMARY KEY (`account_sid`)
) ENGINE=InnoDB COMMENT='A single end-user of the platform';

CREATE TABLE IF NOT EXISTS `subscriptions`
(
`id` INTEGER(10) UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE ,
`subscription_sid` CHAR(36) NOT NULL UNIQUE ,
`registration_sid` CHAR(36) NOT NULL,
`event` VARCHAR(255),
PRIMARY KEY (`id`)
) ENGINE=InnoDB COMMENT='An active sip subscription';

CREATE TABLE IF NOT EXISTS `voip_carriers`
(
`voip_carrier_sid` CHAR(36) NOT NULL UNIQUE ,
`name` VARCHAR(255) NOT NULL UNIQUE ,
`description` VARCHAR(255),
PRIMARY KEY (`voip_carrier_sid`)
) ENGINE=InnoDB COMMENT='An external organization that can provide sip trunking and D';

CREATE TABLE IF NOT EXISTS `phone_numbers`
(
`phone_number_sid` CHAR(36) UNIQUE ,
`number` VARCHAR(255) NOT NULL UNIQUE ,
`voip_carrier_sid` CHAR(36) NOT NULL,
`account_sid` CHAR(36),
`application_sid` CHAR(36),
PRIMARY KEY (`phone_number_sid`)
) ENGINE=InnoDB COMMENT='A phone number that has been assigned to an account';

CREATE TABLE IF NOT EXISTS `sip_gateways`
(
`sip_gateway_sid` CHAR(36),
`ipv4` VARCHAR(32) NOT NULL,
`port` INTEGER NOT NULL DEFAULT 5060,
`inbound` BOOLEAN NOT NULL,
`outbound` BOOLEAN NOT NULL,
`voip_carrier_sid` CHAR(36) NOT NULL,
`is_active` BOOLEAN NOT NULL DEFAULT true,
PRIMARY KEY (`sip_gateway_sid`)
);

CREATE UNIQUE INDEX `applications_idx_name` ON `applications` (`account_sid`,`name`);

CREATE INDEX `applications_application_sid_idx` ON `applications` (`application_sid`);
CREATE INDEX `applications_name_idx` ON `applications` (`name`);
CREATE INDEX `applications_account_sid_idx` ON `applications` (`account_sid`);
ALTER TABLE `applications` ADD FOREIGN KEY account_sid_idxfk (`account_sid`) REFERENCES `accounts` (`account_sid`);

CREATE INDEX `call_routes_call_route_sid_idx` ON `call_routes` (`call_route_sid`);
ALTER TABLE `call_routes` ADD FOREIGN KEY account_sid_idxfk_1 (`account_sid`) REFERENCES `accounts` (`account_sid`);

ALTER TABLE `call_routes` ADD FOREIGN KEY application_sid_idxfk (`application_sid`) REFERENCES `applications` (`application_sid`);

CREATE INDEX `conferences_conference_sid_idx` ON `conferences` (`conference_sid`);
CREATE INDEX `conference_participants_conference_participant_sid_idx` ON `conference_participants` (`conference_participant_sid`);
ALTER TABLE `conference_participants` ADD FOREIGN KEY call_sid_idxfk (`call_sid`) REFERENCES `calls` (`call_sid`);

ALTER TABLE `conference_participants` ADD FOREIGN KEY conference_sid_idxfk (`conference_sid`) REFERENCES `conferences` (`conference_sid`);

CREATE INDEX `queues_queue_sid_idx` ON `queues` (`queue_sid`);
CREATE INDEX `registrations_registration_sid_idx` ON `registrations` (`registration_sid`);
CREATE INDEX `queue_members_queue_member_sid_idx` ON `queue_members` (`queue_member_sid`);
ALTER TABLE `queue_members` ADD FOREIGN KEY call_sid_idxfk_1 (`call_sid`) REFERENCES `calls` (`call_sid`);

ALTER TABLE `queue_members` ADD FOREIGN KEY queue_sid_idxfk (`queue_sid`) REFERENCES `queues` (`queue_sid`);

CREATE INDEX `calls_call_sid_idx` ON `calls` (`call_sid`);
ALTER TABLE `calls` ADD FOREIGN KEY parent_call_sid_idxfk (`parent_call_sid`) REFERENCES `calls` (`call_sid`);

ALTER TABLE `calls` ADD FOREIGN KEY application_sid_idxfk_1 (`application_sid`) REFERENCES `applications` (`application_sid`);

CREATE INDEX `calls_phone_number_sid_idx` ON `calls` (`phone_number_sid`);
ALTER TABLE `calls` ADD FOREIGN KEY phone_number_sid_idxfk (`phone_number_sid`) REFERENCES `phone_numbers` (`phone_number_sid`);

ALTER TABLE `calls` ADD FOREIGN KEY inbound_user_sid_idxfk (`inbound_user_sid`) REFERENCES `registrations` (`registration_sid`);

ALTER TABLE `calls` ADD FOREIGN KEY outbound_user_sid_idxfk (`outbound_user_sid`) REFERENCES `registrations` (`registration_sid`);

CREATE INDEX `service_providers_service_provider_sid_idx` ON `service_providers` (`service_provider_sid`);
CREATE INDEX `service_providers_name_idx` ON `service_providers` (`name`);
CREATE INDEX `service_providers_root_domain_idx` ON `service_providers` (`root_domain`);
CREATE INDEX `api_keys_api_key_sid_idx` ON `api_keys` (`api_key_sid`);
CREATE INDEX `api_keys_account_sid_idx` ON `api_keys` (`account_sid`);
ALTER TABLE `api_keys` ADD FOREIGN KEY account_sid_idxfk_2 (`account_sid`) REFERENCES `accounts` (`account_sid`);

CREATE INDEX `api_keys_service_provider_sid_idx` ON `api_keys` (`service_provider_sid`);
ALTER TABLE `api_keys` ADD FOREIGN KEY service_provider_sid_idxfk (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`);

CREATE INDEX `accounts_account_sid_idx` ON `accounts` (`account_sid`);
CREATE INDEX `accounts_name_idx` ON `accounts` (`name`);
CREATE INDEX `accounts_sip_realm_idx` ON `accounts` (`sip_realm`);
CREATE INDEX `accounts_service_provider_sid_idx` ON `accounts` (`service_provider_sid`);
ALTER TABLE `accounts` ADD FOREIGN KEY service_provider_sid_idxfk_1 (`service_provider_sid`) REFERENCES `service_providers` (`service_provider_sid`);

ALTER TABLE `subscriptions` ADD FOREIGN KEY registration_sid_idxfk (`registration_sid`) REFERENCES `registrations` (`registration_sid`);

CREATE INDEX `voip_carriers_voip_carrier_sid_idx` ON `voip_carriers` (`voip_carrier_sid`);
CREATE INDEX `voip_carriers_name_idx` ON `voip_carriers` (`name`);
CREATE INDEX `phone_numbers_phone_number_sid_idx` ON `phone_numbers` (`phone_number_sid`);
CREATE INDEX `phone_numbers_voip_carrier_sid_idx` ON `phone_numbers` (`voip_carrier_sid`);
ALTER TABLE `phone_numbers` ADD FOREIGN KEY voip_carrier_sid_idxfk (`voip_carrier_sid`) REFERENCES `voip_carriers` (`voip_carrier_sid`);

ALTER TABLE `phone_numbers` ADD FOREIGN KEY account_sid_idxfk_3 (`account_sid`) REFERENCES `accounts` (`account_sid`);

ALTER TABLE `phone_numbers` ADD FOREIGN KEY application_sid_idxfk_2 (`application_sid`) REFERENCES `applications` (`application_sid`);

CREATE UNIQUE INDEX `sip_gateways_sip_gateway_idx_hostport` ON `sip_gateways` (`ipv4`,`port`);

ALTER TABLE `sip_gateways` ADD FOREIGN KEY voip_carrier_sid_idxfk_1 (`voip_carrier_sid`) REFERENCES `voip_carriers` (`voip_carrier_sid`);
