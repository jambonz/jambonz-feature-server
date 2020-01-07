insert into service_providers (service_provider_sid, name, root_domain, registration_hook, hook_basic_auth_user, hook_basic_auth_password) 
values ('3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'SP A', 'jambonz.org', 'http://127.0.0.1:4000/auth', 'foo', 'bar');
insert into accounts(account_sid, service_provider_sid, name, sip_realm, registration_hook, hook_basic_auth_user, hook_basic_auth_password)
values ('ed649e33-e771-403a-8c99-1780eabbc803', '3f35518f-5a0d-4c2e-90a5-2407bb3b36f0', 'test account', 'sip.example.com', 'http://127.0.0.1:4000/auth', 'foo', 'bar');

insert into voip_carriers (voip_carrier_sid, name) values ('287c1452-620d-4195-9f19-c9814ef90d78', 'westco');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound) 
values ('124a5339-c62c-4075-9e19-f4de70a96597', '287c1452-620d-4195-9f19-c9814ef90d78', '172.38.0.20', true, true);
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, port, inbound, outbound) 
values ('efbc4830-57cd-4c78-a56f-d64fdf210fe8', '287c1452-620d-4195-9f19-c9814ef90d78', '3.3.3.3', 5062, false, true);
