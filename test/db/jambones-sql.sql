/* SQLEditor (MySQL (2))*/

SET FOREIGN_KEY_CHECKS=0;

DROP TABLE IF EXISTS account_static_ips;

DROP TABLE IF EXISTS account_limits;

DROP TABLE IF EXISTS account_products;

DROP TABLE IF EXISTS account_subscriptions;

DROP TABLE IF EXISTS beta_invite_codes;

DROP TABLE IF EXISTS call_routes;

DROP TABLE IF EXISTS clients;

DROP TABLE IF EXISTS dns_records;

DROP TABLE IF EXISTS lcr;

DROP TABLE IF EXISTS lcr_carrier_set_entry;

DROP TABLE IF EXISTS lcr_routes;

DROP TABLE IF EXISTS password_settings;

DROP TABLE IF EXISTS user_permissions;

DROP TABLE IF EXISTS permissions;

DROP TABLE IF EXISTS predefined_sip_gateways;

DROP TABLE IF EXISTS predefined_smpp_gateways;

DROP TABLE IF EXISTS predefined_carriers;

DROP TABLE IF EXISTS account_offers;

DROP TABLE IF EXISTS products;

DROP TABLE IF EXISTS schema_version;

DROP TABLE IF EXISTS api_keys;

DROP TABLE IF EXISTS sbc_addresses;

DROP TABLE IF EXISTS ms_teams_tenants;

DROP TABLE IF EXISTS service_provider_limits;

DROP TABLE IF EXISTS signup_history;

DROP TABLE IF EXISTS smpp_addresses;

DROP TABLE IF EXISTS google_custom_voices;

DROP TABLE IF EXISTS speech_credentials;

DROP TABLE IF EXISTS system_information;

DROP TABLE IF EXISTS users;

DROP TABLE IF EXISTS smpp_gateways;

DROP TABLE IF EXISTS phone_numbers;

DROP TABLE IF EXISTS sip_gateways;

DROP TABLE IF EXISTS voip_carriers;

DROP TABLE IF EXISTS accounts;

DROP TABLE IF EXISTS applications;

DROP TABLE IF EXISTS service_providers;

DROP TABLE IF EXISTS webhooks;

CREATE TABLE account_static_ips
(
account_static_ip_sid CHAR(36) NOT NULL UNIQUE ,
account_sid CHAR(36) NOT NULL,
public_ipv4 VARCHAR(16) NOT NULL UNIQUE ,
private_ipv4 VARBINARY(16) NOT NULL UNIQUE ,
PRIMARY KEY (account_static_ip_sid)
);

CREATE TABLE account_limits
(
account_limits_sid CHAR(36) NOT NULL UNIQUE ,
account_sid CHAR(36) NOT NULL,
category ENUM('api_rate','voice_call_session', 'device','voice_call_minutes','voice_call_session_license', 'voice_call_minutes_license') NOT NULL,
quantity INTEGER NOT NULL,
PRIMARY KEY (account_limits_sid)
);

CREATE TABLE account_subscriptions
(
account_subscription_sid CHAR(36) NOT NULL UNIQUE ,
account_sid CHAR(36) NOT NULL,
pending BOOLEAN NOT NULL DEFAULT false,
effective_start_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
effective_end_date DATETIME,
change_reason VARCHAR(255),
stripe_subscription_id VARCHAR(56),
stripe_payment_method_id VARCHAR(56),
stripe_statement_descriptor VARCHAR(255),
last4 VARCHAR(512),
exp_month INTEGER,
exp_year INTEGER,
card_type VARCHAR(16),
pending_reason VARBINARY(52),
PRIMARY KEY (account_subscription_sid)
);

CREATE TABLE beta_invite_codes
(
invite_code CHAR(6) NOT NULL UNIQUE ,
in_use BOOLEAN NOT NULL DEFAULT false,
PRIMARY KEY (invite_code)
);

CREATE TABLE call_routes
(
call_route_sid CHAR(36) NOT NULL UNIQUE ,
priority INTEGER NOT NULL,
account_sid CHAR(36) NOT NULL,
regex VARCHAR(255) NOT NULL,
application_sid CHAR(36) NOT NULL,
PRIMARY KEY (call_route_sid)
) COMMENT='a regex-based pattern match for call routing';

CREATE TABLE clients
(
client_sid CHAR(36) NOT NULL UNIQUE ,
account_sid CHAR(36) NOT NULL,
is_active BOOLEAN NOT NULL DEFAULT 1,
username VARCHAR(64),
password VARCHAR(1024),
allow_direct_app_calling BOOLEAN NOT NULL DEFAULT 1,
allow_direct_queue_calling BOOLEAN NOT NULL DEFAULT 1,
allow_direct_user_calling BOOLEAN NOT NULL DEFAULT 1,
PRIMARY KEY (client_sid)
);

CREATE TABLE dns_records
(
dns_record_sid CHAR(36) NOT NULL UNIQUE ,
account_sid CHAR(36) NOT NULL,
record_type VARCHAR(6) NOT NULL,
record_id INTEGER NOT NULL,
PRIMARY KEY (dns_record_sid)
);

CREATE TABLE lcr_routes
(
lcr_route_sid CHAR(36),
lcr_sid CHAR(36) NOT NULL,
regex VARCHAR(32) NOT NULL COMMENT 'regex-based pattern match against dialed number, used for LCR routing of PSTN calls',
description VARCHAR(1024),
priority INTEGER NOT NULL COMMENT 'lower priority routes are attempted first',
PRIMARY KEY (lcr_route_sid)
) COMMENT='An ordered list of  digit patterns in an LCR table.  The patterns are tested in sequence until one matches';

CREATE TABLE lcr
(
lcr_sid CHAR(36) NOT NULL UNIQUE ,
name VARCHAR(64) COMMENT 'User-assigned name for this LCR table',
is_active BOOLEAN NOT NULL DEFAULT 1,
default_carrier_set_entry_sid CHAR(36) COMMENT 'default carrier/route to use when no digit match based results are found.',
service_provider_sid CHAR(36),
account_sid CHAR(36),
PRIMARY KEY (lcr_sid)
) COMMENT='An LCR (least cost routing) table that is used by a service provider or account to make decisions about routing outbound calls when multiple carriers are available.';

CREATE TABLE password_settings
(
min_password_length INTEGER NOT NULL DEFAULT 8,
require_digit BOOLEAN NOT NULL DEFAULT false,
require_special_character BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE permissions
(
permission_sid CHAR(36) NOT NULL UNIQUE ,
name VARCHAR(32) NOT NULL UNIQUE ,
description VARCHAR(255),
PRIMARY KEY (permission_sid)
);

CREATE TABLE predefined_carriers
(
predefined_carrier_sid CHAR(36) NOT NULL UNIQUE ,
name VARCHAR(64) NOT NULL,
requires_static_ip BOOLEAN NOT NULL DEFAULT false,
e164_leading_plus BOOLEAN NOT NULL DEFAULT false COMMENT 'if true, a leading plus should be prepended to outbound phone numbers',
requires_register BOOLEAN NOT NULL DEFAULT false,
register_username VARCHAR(64),
register_sip_realm VARCHAR(64),
register_password VARCHAR(64),
tech_prefix VARCHAR(16) COMMENT 'tech prefix to prepend to outbound calls to this carrier',
inbound_auth_username VARCHAR(64),
inbound_auth_password VARCHAR(64),
diversion VARCHAR(32),
PRIMARY KEY (predefined_carrier_sid)
);

CREATE TABLE predefined_sip_gateways
(
predefined_sip_gateway_sid CHAR(36) NOT NULL UNIQUE ,
ipv4 VARCHAR(128) NOT NULL COMMENT 'ip address or DNS name of the gateway.  For gateways providing inbound calling service, ip address is required.',
port INTEGER NOT NULL DEFAULT 5060 COMMENT 'sip signaling port',
inbound BOOLEAN NOT NULL COMMENT 'if true, whitelist this IP to allow inbound calls from the gateway',
outbound BOOLEAN NOT NULL COMMENT 'if true, include in least-cost routing when placing calls to the PSTN',
netmask INTEGER NOT NULL DEFAULT 32,
predefined_carrier_sid CHAR(36) NOT NULL,
PRIMARY KEY (predefined_sip_gateway_sid)
);

CREATE TABLE predefined_smpp_gateways
(
predefined_smpp_gateway_sid CHAR(36) NOT NULL UNIQUE ,
ipv4 VARCHAR(128) NOT NULL COMMENT 'ip address or DNS name of the gateway. ',
port INTEGER NOT NULL DEFAULT 2775 COMMENT 'smpp signaling port',
inbound BOOLEAN NOT NULL COMMENT 'if true, whitelist this IP to allow inbound SMS from the gateway',
outbound BOOLEAN NOT NULL COMMENT 'i',
netmask INTEGER NOT NULL DEFAULT 32,
is_primary BOOLEAN NOT NULL DEFAULT 1,
use_tls BOOLEAN DEFAULT 0,
predefined_carrier_sid CHAR(36) NOT NULL,
PRIMARY KEY (predefined_smpp_gateway_sid)
);

CREATE TABLE products
(
product_sid CHAR(36) NOT NULL UNIQUE ,
name VARCHAR(32) NOT NULL,
category ENUM('api_rate','voice_call_session', 'device') NOT NULL,
PRIMARY KEY (product_sid)
);

CREATE TABLE account_products
(
account_product_sid CHAR(36) NOT NULL UNIQUE ,
account_subscription_sid CHAR(36) NOT NULL,
product_sid CHAR(36) NOT NULL,
quantity INTEGER NOT NULL,
PRIMARY KEY (account_product_sid)
);

CREATE TABLE account_offers
(
account_offer_sid CHAR(36) NOT NULL UNIQUE ,
account_sid CHAR(36) NOT NULL,
product_sid CHAR(36) NOT NULL,
stripe_product_id VARCHAR(56) NOT NULL,
PRIMARY KEY (account_offer_sid)
);

CREATE TABLE schema_version
(
version VARCHAR(16)
);

CREATE TABLE api_keys
(
api_key_sid CHAR(36) NOT NULL UNIQUE ,
token CHAR(36) NOT NULL UNIQUE ,
account_sid CHAR(36),
service_provider_sid CHAR(36),
expires_at TIMESTAMP NULL  DEFAULT NULL,
last_used TIMESTAMP NULL  DEFAULT NULL,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
PRIMARY KEY (api_key_sid)
) COMMENT='An authorization token that is used to access the REST api';

CREATE TABLE sbc_addresses
(
sbc_address_sid CHAR(36) NOT NULL UNIQUE ,
ipv4 VARCHAR(255) NOT NULL,
port INTEGER NOT NULL DEFAULT 5060,
tls_port INTEGER,
wss_port INTEGER,
service_provider_sid CHAR(36),
last_updated DATETIME,
PRIMARY KEY (sbc_address_sid)
);

CREATE TABLE ms_teams_tenants
(
ms_teams_tenant_sid CHAR(36) NOT NULL UNIQUE ,
service_provider_sid CHAR(36) NOT NULL,
account_sid CHAR(36) NOT NULL,
application_sid CHAR(36),
tenant_fqdn VARCHAR(255) NOT NULL UNIQUE ,
PRIMARY KEY (ms_teams_tenant_sid)
) COMMENT='A Microsoft Teams customer tenant';

CREATE TABLE service_provider_limits
(
service_provider_limits_sid CHAR(36) NOT NULL UNIQUE ,
service_provider_sid CHAR(36) NOT NULL,
category ENUM('api_rate','voice_call_session', 'device','voice_call_minutes','voice_call_session_license', 'voice_call_minutes_license') NOT NULL,
quantity INTEGER NOT NULL,
PRIMARY KEY (service_provider_limits_sid)
);

CREATE TABLE signup_history
(
email VARCHAR(255) NOT NULL,
name VARCHAR(255),
signed_up_at DATETIME DEFAULT CURRENT_TIMESTAMP,
PRIMARY KEY (email)
);

CREATE TABLE smpp_addresses
(
smpp_address_sid CHAR(36) NOT NULL UNIQUE ,
ipv4 VARCHAR(255) NOT NULL,
port INTEGER NOT NULL DEFAULT 5060,
use_tls BOOLEAN NOT NULL DEFAULT 0,
is_primary BOOLEAN NOT NULL DEFAULT 1,
service_provider_sid CHAR(36),
PRIMARY KEY (smpp_address_sid)
);

CREATE TABLE speech_credentials
(
speech_credential_sid CHAR(36) NOT NULL UNIQUE ,
service_provider_sid CHAR(36),
account_sid CHAR(36),
vendor VARCHAR(32) NOT NULL,
credential VARCHAR(8192) NOT NULL,
use_for_tts BOOLEAN DEFAULT true,
use_for_stt BOOLEAN DEFAULT true,
last_used DATETIME,
last_tested DATETIME,
tts_tested_ok BOOLEAN,
stt_tested_ok BOOLEAN,
created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
label VARCHAR(64),
PRIMARY KEY (speech_credential_sid)
);

CREATE TABLE google_custom_voices
(
google_custom_voice_sid CHAR(36) NOT NULL UNIQUE ,
speech_credential_sid CHAR(36) NOT NULL,
model VARCHAR(512) NOT NULL,
reported_usage ENUM('REPORTED_USAGE_UNSPECIFIED','REALTIME','OFFLINE') DEFAULT 'REALTIME',
name VARCHAR(64) NOT NULL,
PRIMARY KEY (google_custom_voice_sid)
);

CREATE TABLE system_information
(
domain_name VARCHAR(255),
sip_domain_name VARCHAR(255),
monitoring_domain_name VARCHAR(255),
private_network_cidr VARCHAR(8192),
log_level ENUM('info', 'debug') NOT NULL DEFAULT 'info'
);

CREATE TABLE users
(
user_sid CHAR(36) NOT NULL UNIQUE ,
name VARCHAR(255) NOT NULL,
email VARCHAR(255) NOT NULL,
pending_email VARCHAR(255),
phone VARCHAR(20) UNIQUE ,
hashed_password VARCHAR(1024),
account_sid CHAR(36),
service_provider_sid CHAR(36),
force_change BOOLEAN NOT NULL DEFAULT FALSE,
provider VARCHAR(255) NOT NULL,
provider_userid VARCHAR(255),
scope VARCHAR(16) NOT NULL DEFAULT 'read-write',
phone_activation_code VARCHAR(16),
email_activation_code VARCHAR(16),
email_validated BOOLEAN NOT NULL DEFAULT false,
phone_validated BOOLEAN NOT NULL DEFAULT false,
email_content_opt_out BOOLEAN NOT NULL DEFAULT false,
is_active BOOLEAN NOT NULL DEFAULT true,
PRIMARY KEY (user_sid)
);

CREATE TABLE voip_carriers
(
voip_carrier_sid CHAR(36) NOT NULL UNIQUE ,
name VARCHAR(64) NOT NULL,
description VARCHAR(255),
account_sid CHAR(36) COMMENT 'if provided, indicates this entity represents a sip trunk that is associated with a specific account',
service_provider_sid CHAR(36),
application_sid CHAR(36) COMMENT 'If provided, all incoming calls from this source will be routed to the associated application',
e164_leading_plus BOOLEAN NOT NULL DEFAULT false COMMENT 'if true, a leading plus should be prepended to outbound phone numbers',
requires_register BOOLEAN NOT NULL DEFAULT false,
register_username VARCHAR(64),
register_sip_realm VARCHAR(64),
register_password VARCHAR(64),
tech_prefix VARCHAR(16) COMMENT 'tech prefix to prepend to outbound calls to this carrier',
inbound_auth_username VARCHAR(64),
inbound_auth_password VARCHAR(64),
diversion VARCHAR(32),
is_active BOOLEAN NOT NULL DEFAULT true,
created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
smpp_system_id VARCHAR(255),
smpp_password VARCHAR(64),
smpp_enquire_link_interval INTEGER DEFAULT 0,
smpp_inbound_system_id VARCHAR(255),
smpp_inbound_password VARCHAR(64),
register_from_user VARCHAR(128),
register_from_domain VARCHAR(255),
register_public_ip_in_contact BOOLEAN NOT NULL DEFAULT false,
register_status VARCHAR(4096),
PRIMARY KEY (voip_carrier_sid)
) COMMENT='A Carrier or customer PBX that can send or receive calls';

CREATE TABLE user_permissions
(
user_permissions_sid CHAR(36) NOT NULL UNIQUE ,
user_sid CHAR(36) NOT NULL,
permission_sid CHAR(36) NOT NULL,
PRIMARY KEY (user_permissions_sid)
);

CREATE TABLE smpp_gateways
(
smpp_gateway_sid CHAR(36) NOT NULL UNIQUE ,
ipv4 VARCHAR(128) NOT NULL,
port INTEGER NOT NULL DEFAULT 2775,
netmask INTEGER NOT NULL DEFAULT 32,
is_primary BOOLEAN NOT NULL DEFAULT 1,
inbound BOOLEAN NOT NULL DEFAULT 0 COMMENT 'if true, whitelist this IP to allow inbound calls from the gateway',
outbound BOOLEAN NOT NULL DEFAULT 1 COMMENT 'if true, include in least-cost routing when placing calls to the PSTN',
use_tls BOOLEAN DEFAULT 0,
voip_carrier_sid CHAR(36) NOT NULL,
PRIMARY KEY (smpp_gateway_sid)
);

CREATE TABLE phone_numbers
(
phone_number_sid CHAR(36) UNIQUE ,
number VARCHAR(132) NOT NULL,
voip_carrier_sid CHAR(36),
account_sid CHAR(36),
application_sid CHAR(36),
service_provider_sid CHAR(36) COMMENT 'if not null, this number is a test number for the associated service provider',
PRIMARY KEY (phone_number_sid)
) COMMENT='A phone number that has been assigned to an account';

CREATE TABLE sip_gateways
(
sip_gateway_sid CHAR(36),
ipv4 VARCHAR(128) NOT NULL COMMENT 'ip address or DNS name of the gateway.  For gateways providing inbound calling service, ip address is required.',
netmask INTEGER NOT NULL DEFAULT 32,
port INTEGER COMMENT 'sip signaling port',
inbound BOOLEAN NOT NULL COMMENT 'if true, whitelist this IP to allow inbound calls from the gateway',
outbound BOOLEAN NOT NULL COMMENT 'if true, include in least-cost routing when placing calls to the PSTN',
voip_carrier_sid CHAR(36) NOT NULL,
is_active BOOLEAN NOT NULL DEFAULT 1,
send_options_ping BOOLEAN NOT NULL DEFAULT 0,
use_sips_scheme BOOLEAN NOT NULL DEFAULT 0,
pad_crypto BOOLEAN NOT NULL DEFAULT 0,
protocol ENUM('udp','tcp','tls', 'tls/srtp') DEFAULT 'udp' COMMENT 'Outbound call protocol',
PRIMARY KEY (sip_gateway_sid)
) COMMENT='A whitelisted sip gateway used for origination/termination';

CREATE TABLE lcr_carrier_set_entry
(
lcr_carrier_set_entry_sid CHAR(36),
workload INTEGER NOT NULL DEFAULT 1 COMMENT 'represents a proportion of traffic to send through the associated carrier; can be used for load balancing traffic across carriers with a common priority for a destination',
lcr_route_sid CHAR(36) NOT NULL,
voip_carrier_sid CHAR(36) NOT NULL,
priority INTEGER NOT NULL DEFAULT 0 COMMENT 'lower priority carriers are attempted first',
PRIMARY KEY (lcr_carrier_set_entry_sid)
) COMMENT='An entry in the LCR routing list';

CREATE TABLE webhooks
(
webhook_sid CHAR(36) NOT NULL UNIQUE ,
url VARCHAR(1024) NOT NULL,
method ENUM("GET","POST") NOT NULL DEFAULT 'POST',
username VARCHAR(255),
password VARCHAR(255),
PRIMARY KEY (webhook_sid)
) COMMENT='An HTTP callback';

CREATE TABLE applications
(
application_sid CHAR(36) NOT NULL UNIQUE ,
name VARCHAR(64) NOT NULL,
service_provider_sid CHAR(36) COMMENT 'if non-null, this application is a test application that can be used by any account under the associated service provider',
account_sid CHAR(36) COMMENT 'account that this application belongs to (if null, this is a service provider test application)',
call_hook_sid CHAR(36) COMMENT 'webhook to call for inbound calls ',
call_status_hook_sid CHAR(36) COMMENT 'webhook to call for call status events',
messaging_hook_sid CHAR(36) COMMENT 'webhook to call for inbound SMS/MMS ',
app_json TEXT,
speech_synthesis_vendor VARCHAR(64) NOT NULL DEFAULT 'google',
speech_synthesis_language VARCHAR(12) NOT NULL DEFAULT 'en-US',
speech_synthesis_voice VARCHAR(256),
speech_synthesis_label VARCHAR(64),
speech_recognizer_vendor VARCHAR(64) NOT NULL DEFAULT 'google',
speech_recognizer_language VARCHAR(64) NOT NULL DEFAULT 'en-US',
speech_recognizer_label VARCHAR(64),
use_for_fallback_speech BOOLEAN DEFAULT false,
fallback_speech_synthesis_vendor VARCHAR(64),
fallback_speech_synthesis_language VARCHAR(12),
fallback_speech_synthesis_voice VARCHAR(256),
fallback_speech_synthesis_label VARCHAR(64),
fallback_speech_recognizer_vendor VARCHAR(64),
fallback_speech_recognizer_language VARCHAR(64),
fallback_speech_recognizer_label VARCHAR(64),
created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
record_all_calls BOOLEAN NOT NULL DEFAULT false,
PRIMARY KEY (application_sid)
) COMMENT='A defined set of behaviors to be applied to phone calls ';

CREATE TABLE service_providers
(
service_provider_sid CHAR(36) NOT NULL UNIQUE ,
name VARCHAR(64) NOT NULL UNIQUE ,
description VARCHAR(255),
root_domain VARCHAR(128) UNIQUE ,
registration_hook_sid CHAR(36),
ms_teams_fqdn VARCHAR(255),
PRIMARY KEY (service_provider_sid)
) COMMENT='A partition of the platform used by one service provider';

CREATE TABLE accounts
(
account_sid CHAR(36) NOT NULL UNIQUE ,
name VARCHAR(64) NOT NULL,
sip_realm VARCHAR(132) UNIQUE  COMMENT 'sip domain that will be used for devices registering under this account',
service_provider_sid CHAR(36) NOT NULL COMMENT 'service provider that owns the customer relationship with this account',
registration_hook_sid CHAR(36) COMMENT 'webhook to call when devices underr this account attempt to register',
queue_event_hook_sid CHAR(36),
device_calling_application_sid CHAR(36) COMMENT 'application to use for outbound calling from an account',
is_active BOOLEAN NOT NULL DEFAULT true,
created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
plan_type ENUM('trial','free','paid') NOT NULL DEFAULT 'trial',
stripe_customer_id VARCHAR(56),
webhook_secret VARCHAR(36) NOT NULL,
disable_cdrs BOOLEAN NOT NULL DEFAULT 0,
trial_end_date DATETIME,
deactivated_reason VARCHAR(255),
device_to_call_ratio INTEGER NOT NULL DEFAULT 5,
subspace_client_id VARCHAR(255),
subspace_client_secret VARCHAR(255),
subspace_sip_teleport_id VARCHAR(255),
subspace_sip_teleport_destinations VARCHAR(255),
siprec_hook_sid CHAR(36),
record_all_calls BOOLEAN NOT NULL DEFAULT false,
record_format VARCHAR(16) NOT NULL DEFAULT 'mp3',
bucket_credential VARCHAR(8192) COMMENT 'credential used to authenticate with storage service',
enable_debug_log BOOLEAN NOT NULL DEFAULT false,
PRIMARY KEY (account_sid)
) COMMENT='An enterprise that uses the platform for comm services';

CREATE INDEX account_static_ip_sid_idx ON account_static_ips (account_static_ip_sid);
CREATE INDEX account_sid_idx ON account_static_ips (account_sid);
ALTER TABLE account_static_ips ADD FOREIGN KEY account_sid_idxfk (account_sid) REFERENCES accounts (account_sid);

CREATE INDEX account_sid_idx ON account_limits (account_sid);
ALTER TABLE account_limits ADD FOREIGN KEY account_sid_idxfk_1 (account_sid) REFERENCES accounts (account_sid) ON DELETE CASCADE;

CREATE INDEX account_subscription_sid_idx ON account_subscriptions (account_subscription_sid);
CREATE INDEX account_sid_idx ON account_subscriptions (account_sid);
ALTER TABLE account_subscriptions ADD FOREIGN KEY account_sid_idxfk_2 (account_sid) REFERENCES accounts (account_sid);

CREATE INDEX invite_code_idx ON beta_invite_codes (invite_code);
CREATE INDEX call_route_sid_idx ON call_routes (call_route_sid);
ALTER TABLE call_routes ADD FOREIGN KEY account_sid_idxfk_3 (account_sid) REFERENCES accounts (account_sid);

ALTER TABLE call_routes ADD FOREIGN KEY application_sid_idxfk (application_sid) REFERENCES applications (application_sid);

CREATE INDEX client_sid_idx ON clients (client_sid);
ALTER TABLE clients ADD CONSTRAINT account_sid_idxfk_13 FOREIGN KEY account_sid_idxfk_13 (account_sid) REFERENCES accounts (account_sid);

CREATE INDEX dns_record_sid_idx ON dns_records (dns_record_sid);
ALTER TABLE dns_records ADD FOREIGN KEY account_sid_idxfk_4 (account_sid) REFERENCES accounts (account_sid);

CREATE INDEX lcr_sid_idx ON lcr_routes (lcr_sid);
ALTER TABLE lcr_routes ADD FOREIGN KEY lcr_sid_idxfk (lcr_sid) REFERENCES lcr (lcr_sid);

CREATE INDEX lcr_sid_idx ON lcr (lcr_sid);
ALTER TABLE lcr ADD FOREIGN KEY default_carrier_set_entry_sid_idxfk (default_carrier_set_entry_sid) REFERENCES lcr_carrier_set_entry (lcr_carrier_set_entry_sid);

CREATE INDEX service_provider_sid_idx ON lcr (service_provider_sid);
CREATE INDEX account_sid_idx ON lcr (account_sid);
CREATE INDEX permission_sid_idx ON permissions (permission_sid);
CREATE INDEX predefined_carrier_sid_idx ON predefined_carriers (predefined_carrier_sid);
CREATE INDEX predefined_sip_gateway_sid_idx ON predefined_sip_gateways (predefined_sip_gateway_sid);
CREATE INDEX predefined_carrier_sid_idx ON predefined_sip_gateways (predefined_carrier_sid);
ALTER TABLE predefined_sip_gateways ADD FOREIGN KEY predefined_carrier_sid_idxfk (predefined_carrier_sid) REFERENCES predefined_carriers (predefined_carrier_sid);

CREATE INDEX predefined_smpp_gateway_sid_idx ON predefined_smpp_gateways (predefined_smpp_gateway_sid);
CREATE INDEX predefined_carrier_sid_idx ON predefined_smpp_gateways (predefined_carrier_sid);
ALTER TABLE predefined_smpp_gateways ADD FOREIGN KEY predefined_carrier_sid_idxfk_1 (predefined_carrier_sid) REFERENCES predefined_carriers (predefined_carrier_sid);

CREATE INDEX product_sid_idx ON products (product_sid);
CREATE INDEX account_product_sid_idx ON account_products (account_product_sid);
CREATE INDEX account_subscription_sid_idx ON account_products (account_subscription_sid);
ALTER TABLE account_products ADD FOREIGN KEY account_subscription_sid_idxfk (account_subscription_sid) REFERENCES account_subscriptions (account_subscription_sid);

ALTER TABLE account_products ADD FOREIGN KEY product_sid_idxfk (product_sid) REFERENCES products (product_sid);

CREATE INDEX account_offer_sid_idx ON account_offers (account_offer_sid);
CREATE INDEX account_sid_idx ON account_offers (account_sid);
ALTER TABLE account_offers ADD FOREIGN KEY account_sid_idxfk_5 (account_sid) REFERENCES accounts (account_sid);

CREATE INDEX product_sid_idx ON account_offers (product_sid);
ALTER TABLE account_offers ADD FOREIGN KEY product_sid_idxfk_1 (product_sid) REFERENCES products (product_sid);

CREATE INDEX api_key_sid_idx ON api_keys (api_key_sid);
CREATE INDEX account_sid_idx ON api_keys (account_sid);
ALTER TABLE api_keys ADD FOREIGN KEY account_sid_idxfk_6 (account_sid) REFERENCES accounts (account_sid);

CREATE INDEX service_provider_sid_idx ON api_keys (service_provider_sid);
ALTER TABLE api_keys ADD FOREIGN KEY service_provider_sid_idxfk (service_provider_sid) REFERENCES service_providers (service_provider_sid);

CREATE INDEX sbc_addresses_idx_host_port ON sbc_addresses (ipv4,port);

CREATE INDEX sbc_address_sid_idx ON sbc_addresses (sbc_address_sid);
CREATE INDEX service_provider_sid_idx ON sbc_addresses (service_provider_sid);
ALTER TABLE sbc_addresses ADD FOREIGN KEY service_provider_sid_idxfk_1 (service_provider_sid) REFERENCES service_providers (service_provider_sid);

CREATE INDEX ms_teams_tenant_sid_idx ON ms_teams_tenants (ms_teams_tenant_sid);
ALTER TABLE ms_teams_tenants ADD FOREIGN KEY service_provider_sid_idxfk_2 (service_provider_sid) REFERENCES service_providers (service_provider_sid);

ALTER TABLE ms_teams_tenants ADD FOREIGN KEY account_sid_idxfk_7 (account_sid) REFERENCES accounts (account_sid);

ALTER TABLE ms_teams_tenants ADD FOREIGN KEY application_sid_idxfk_1 (application_sid) REFERENCES applications (application_sid);

CREATE INDEX tenant_fqdn_idx ON ms_teams_tenants (tenant_fqdn);
CREATE INDEX service_provider_sid_idx ON service_provider_limits (service_provider_sid);
ALTER TABLE service_provider_limits ADD FOREIGN KEY service_provider_sid_idxfk_3 (service_provider_sid) REFERENCES service_providers (service_provider_sid) ON DELETE CASCADE;

CREATE INDEX email_idx ON signup_history (email);
CREATE INDEX smpp_address_sid_idx ON smpp_addresses (smpp_address_sid);
CREATE INDEX service_provider_sid_idx ON smpp_addresses (service_provider_sid);
ALTER TABLE smpp_addresses ADD FOREIGN KEY service_provider_sid_idxfk_4 (service_provider_sid) REFERENCES service_providers (service_provider_sid);

CREATE INDEX speech_credential_sid_idx ON speech_credentials (speech_credential_sid);
CREATE INDEX service_provider_sid_idx ON speech_credentials (service_provider_sid);
ALTER TABLE speech_credentials ADD FOREIGN KEY service_provider_sid_idxfk_5 (service_provider_sid) REFERENCES service_providers (service_provider_sid);

CREATE INDEX account_sid_idx ON speech_credentials (account_sid);
ALTER TABLE speech_credentials ADD FOREIGN KEY account_sid_idxfk_8 (account_sid) REFERENCES accounts (account_sid);

CREATE INDEX google_custom_voice_sid_idx ON google_custom_voices (google_custom_voice_sid);
CREATE INDEX speech_credential_sid_idx ON google_custom_voices (speech_credential_sid);
ALTER TABLE google_custom_voices ADD FOREIGN KEY speech_credential_sid_idxfk (speech_credential_sid) REFERENCES speech_credentials (speech_credential_sid) ON DELETE CASCADE;

CREATE INDEX user_sid_idx ON users (user_sid);
CREATE INDEX email_idx ON users (email);
CREATE INDEX phone_idx ON users (phone);
CREATE INDEX account_sid_idx ON users (account_sid);
ALTER TABLE users ADD FOREIGN KEY account_sid_idxfk_9 (account_sid) REFERENCES accounts (account_sid);

CREATE INDEX service_provider_sid_idx ON users (service_provider_sid);
ALTER TABLE users ADD FOREIGN KEY service_provider_sid_idxfk_6 (service_provider_sid) REFERENCES service_providers (service_provider_sid);

CREATE INDEX email_activation_code_idx ON users (email_activation_code);
CREATE INDEX voip_carrier_sid_idx ON voip_carriers (voip_carrier_sid);
CREATE INDEX account_sid_idx ON voip_carriers (account_sid);
ALTER TABLE voip_carriers ADD FOREIGN KEY account_sid_idxfk_10 (account_sid) REFERENCES accounts (account_sid);

CREATE INDEX service_provider_sid_idx ON voip_carriers (service_provider_sid);
ALTER TABLE voip_carriers ADD FOREIGN KEY service_provider_sid_idxfk_7 (service_provider_sid) REFERENCES service_providers (service_provider_sid);

ALTER TABLE voip_carriers ADD FOREIGN KEY application_sid_idxfk_2 (application_sid) REFERENCES applications (application_sid);

CREATE INDEX user_permissions_sid_idx ON user_permissions (user_permissions_sid);
CREATE INDEX user_sid_idx ON user_permissions (user_sid);
ALTER TABLE user_permissions ADD FOREIGN KEY user_sid_idxfk (user_sid) REFERENCES users (user_sid) ON DELETE CASCADE;

ALTER TABLE user_permissions ADD FOREIGN KEY permission_sid_idxfk (permission_sid) REFERENCES permissions (permission_sid);

CREATE INDEX smpp_gateway_sid_idx ON smpp_gateways (smpp_gateway_sid);
CREATE INDEX voip_carrier_sid_idx ON smpp_gateways (voip_carrier_sid);
ALTER TABLE smpp_gateways ADD FOREIGN KEY voip_carrier_sid_idxfk (voip_carrier_sid) REFERENCES voip_carriers (voip_carrier_sid);

CREATE UNIQUE INDEX phone_numbers_unique_idx_voip_carrier_number ON phone_numbers (number,voip_carrier_sid);

CREATE INDEX phone_number_sid_idx ON phone_numbers (phone_number_sid);
CREATE INDEX number_idx ON phone_numbers (number);
CREATE INDEX voip_carrier_sid_idx ON phone_numbers (voip_carrier_sid);
ALTER TABLE phone_numbers ADD FOREIGN KEY voip_carrier_sid_idxfk_1 (voip_carrier_sid) REFERENCES voip_carriers (voip_carrier_sid);

ALTER TABLE phone_numbers ADD FOREIGN KEY account_sid_idxfk_11 (account_sid) REFERENCES accounts (account_sid);

ALTER TABLE phone_numbers ADD FOREIGN KEY application_sid_idxfk_3 (application_sid) REFERENCES applications (application_sid);

CREATE INDEX service_provider_sid_idx ON phone_numbers (service_provider_sid);
ALTER TABLE phone_numbers ADD FOREIGN KEY service_provider_sid_idxfk_8 (service_provider_sid) REFERENCES service_providers (service_provider_sid);

CREATE INDEX sip_gateway_idx_hostport ON sip_gateways (ipv4,port);

CREATE INDEX voip_carrier_sid_idx ON sip_gateways (voip_carrier_sid);
ALTER TABLE sip_gateways ADD FOREIGN KEY voip_carrier_sid_idxfk_2 (voip_carrier_sid) REFERENCES voip_carriers (voip_carrier_sid);

ALTER TABLE lcr_carrier_set_entry ADD FOREIGN KEY lcr_route_sid_idxfk (lcr_route_sid) REFERENCES lcr_routes (lcr_route_sid);

ALTER TABLE lcr_carrier_set_entry ADD FOREIGN KEY voip_carrier_sid_idxfk_3 (voip_carrier_sid) REFERENCES voip_carriers (voip_carrier_sid);

CREATE INDEX webhook_sid_idx ON webhooks (webhook_sid);
CREATE UNIQUE INDEX applications_idx_name ON applications (account_sid,name);

CREATE INDEX application_sid_idx ON applications (application_sid);
CREATE INDEX service_provider_sid_idx ON applications (service_provider_sid);
ALTER TABLE applications ADD FOREIGN KEY service_provider_sid_idxfk_9 (service_provider_sid) REFERENCES service_providers (service_provider_sid);

CREATE INDEX account_sid_idx ON applications (account_sid);
ALTER TABLE applications ADD FOREIGN KEY account_sid_idxfk_12 (account_sid) REFERENCES accounts (account_sid);

ALTER TABLE applications ADD FOREIGN KEY call_hook_sid_idxfk (call_hook_sid) REFERENCES webhooks (webhook_sid);

ALTER TABLE applications ADD FOREIGN KEY call_status_hook_sid_idxfk (call_status_hook_sid) REFERENCES webhooks (webhook_sid);

ALTER TABLE applications ADD FOREIGN KEY messaging_hook_sid_idxfk (messaging_hook_sid) REFERENCES webhooks (webhook_sid);

CREATE INDEX service_provider_sid_idx ON service_providers (service_provider_sid);
CREATE INDEX name_idx ON service_providers (name);
CREATE INDEX root_domain_idx ON service_providers (root_domain);
ALTER TABLE service_providers ADD FOREIGN KEY registration_hook_sid_idxfk (registration_hook_sid) REFERENCES webhooks (webhook_sid);

CREATE INDEX account_sid_idx ON accounts (account_sid);
CREATE INDEX sip_realm_idx ON accounts (sip_realm);
CREATE INDEX service_provider_sid_idx ON accounts (service_provider_sid);
ALTER TABLE accounts ADD FOREIGN KEY service_provider_sid_idxfk_10 (service_provider_sid) REFERENCES service_providers (service_provider_sid);

ALTER TABLE accounts ADD FOREIGN KEY registration_hook_sid_idxfk_1 (registration_hook_sid) REFERENCES webhooks (webhook_sid);

ALTER TABLE accounts ADD FOREIGN KEY queue_event_hook_sid_idxfk (queue_event_hook_sid) REFERENCES webhooks (webhook_sid);

ALTER TABLE accounts ADD FOREIGN KEY device_calling_application_sid_idxfk (device_calling_application_sid) REFERENCES applications (application_sid);

ALTER TABLE accounts ADD FOREIGN KEY siprec_hook_sid_idxfk (siprec_hook_sid) REFERENCES applications (application_sid);

SET FOREIGN_KEY_CHECKS=1;
