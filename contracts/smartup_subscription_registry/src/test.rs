#[cfg(test)]
mod test {
    use super::super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, String};

    fn s(env: &Env, v: &str) -> String {
        String::from_str(env, v)
    }

    // ── lifecycle & authorization ─────────────────────────────────────────────

    #[test]
    fn lifecycle_and_authorization() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SubscriptionRegistry);
        let client = SubscriptionRegistryClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let monitored = Address::generate(&env);

        client.register(
            &s(&env, "sub_1"),
            &owner,
            &monitored,
            &s(&env, "testnet"),
            &s(&env, "payment_received"),
            &s(&env, "https://example.com/hook"),
        );

        // starts active
        assert!(client.get(&s(&env, "sub_1")).active);
        assert_eq!(client.get(&s(&env, "sub_1")).owner, owner);

        // pause
        client.set_active(&s(&env, "sub_1"), &false);
        assert!(!client.get(&s(&env, "sub_1")).active);

        // resume
        client.set_active(&s(&env, "sub_1"), &true);
        assert!(client.get(&s(&env, "sub_1")).active);

        // update filter + destination
        client.update(
            &s(&env, "sub_1"),
            &s(&env, "membership_renewed"),
            &s(&env, "https://example.com/hook/v2"),
        );
        let updated = client.get(&s(&env, "sub_1"));
        assert_eq!(updated.event_filter, s(&env, "membership_renewed"));
        assert_eq!(updated.destination, s(&env, "https://example.com/hook/v2"));

        // remove
        client.remove(&s(&env, "sub_1"));
    }

    // ── list_by_owner ─────────────────────────────────────────────────────────

    #[test]
    fn list_by_owner_returns_all_registered_ids() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SubscriptionRegistry);
        let client = SubscriptionRegistryClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let other = Address::generate(&env);
        let monitored = Address::generate(&env);

        client.register(&s(&env, "a"), &owner, &monitored, &s(&env, "testnet"), &s(&env, "evt"), &s(&env, "https://x.com"));
        client.register(&s(&env, "b"), &owner, &monitored, &s(&env, "testnet"), &s(&env, "evt"), &s(&env, "https://x.com"));
        client.register(&s(&env, "c"), &other, &monitored, &s(&env, "mainnet"), &s(&env, "evt"), &s(&env, "https://x.com"));

        let owner_ids = client.list_by_owner(&owner);
        assert_eq!(owner_ids.len(), 2);
        assert!(owner_ids.contains(&s(&env, "a")));
        assert!(owner_ids.contains(&s(&env, "b")));

        let other_ids = client.list_by_owner(&other);
        assert_eq!(other_ids.len(), 1);
        assert!(other_ids.contains(&s(&env, "c")));
    }

    // ── list_by_owner after remove ────────────────────────────────────────────

    #[test]
    fn list_by_owner_shrinks_after_remove() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SubscriptionRegistry);
        let client = SubscriptionRegistryClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let monitored = Address::generate(&env);

        client.register(&s(&env, "x"), &owner, &monitored, &s(&env, "testnet"), &s(&env, "e"), &s(&env, "https://x.com"));
        client.register(&s(&env, "y"), &owner, &monitored, &s(&env, "testnet"), &s(&env, "e"), &s(&env, "https://x.com"));
        assert_eq!(client.list_by_owner(&owner).len(), 2);

        client.remove(&s(&env, "x"));
        let remaining = client.list_by_owner(&owner);
        assert_eq!(remaining.len(), 1);
        assert!(remaining.contains(&s(&env, "y")));
    }

    // ── duplicate registration ────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "subscription already exists")]
    fn register_duplicate_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SubscriptionRegistry);
        let client = SubscriptionRegistryClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let monitored = Address::generate(&env);

        client.register(&s(&env, "dup"), &owner, &monitored, &s(&env, "testnet"), &s(&env, "evt"), &s(&env, "https://x.com"));
        client.register(&s(&env, "dup"), &owner, &monitored, &s(&env, "testnet"), &s(&env, "evt"), &s(&env, "https://x.com"));
    }

    // ── get non-existent ─────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "subscription not found")]
    fn get_missing_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SubscriptionRegistry);
        let client = SubscriptionRegistryClient::new(&env, &contract_id);
        client.get(&s(&env, "nonexistent"));
    }

    // ── update non-existent ───────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "subscription not found")]
    fn update_missing_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SubscriptionRegistry);
        let client = SubscriptionRegistryClient::new(&env, &contract_id);
        client.update(&s(&env, "ghost"), &s(&env, "evt"), &s(&env, "https://x.com"));
    }

    // ── remove non-existent ───────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "subscription not found")]
    fn remove_missing_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SubscriptionRegistry);
        let client = SubscriptionRegistryClient::new(&env, &contract_id);
        client.remove(&s(&env, "ghost"));
    }

    // ── invalid id (empty) ────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "invalid subscription id")]
    fn register_empty_id_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SubscriptionRegistry);
        let client = SubscriptionRegistryClient::new(&env, &contract_id);
        client.register(
            &s(&env, ""),
            &Address::generate(&env),
            &Address::generate(&env),
            &s(&env, "testnet"),
            &s(&env, "evt"),
            &s(&env, "https://x.com"),
        );
    }

    // ── invalid metadata (empty filter) ──────────────────────────────────────

    #[test]
    #[should_panic(expected = "invalid subscription metadata")]
    fn register_empty_filter_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SubscriptionRegistry);
        let client = SubscriptionRegistryClient::new(&env, &contract_id);
        client.register(
            &s(&env, "sub_x"),
            &Address::generate(&env),
            &Address::generate(&env),
            &s(&env, "testnet"),
            &s(&env, ""),
            &s(&env, "https://x.com"),
        );
    }

    // ── invalid metadata (empty destination) ─────────────────────────────────

    #[test]
    #[should_panic(expected = "invalid subscription metadata")]
    fn register_empty_destination_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SubscriptionRegistry);
        let client = SubscriptionRegistryClient::new(&env, &contract_id);
        client.register(
            &s(&env, "sub_x"),
            &Address::generate(&env),
            &Address::generate(&env),
            &s(&env, "testnet"),
            &s(&env, "payment_received"),
            &s(&env, ""),
        );
    }

    // ── invalid network ───────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "network must be testnet or mainnet")]
    fn register_invalid_network_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SubscriptionRegistry);
        let client = SubscriptionRegistryClient::new(&env, &contract_id);
        client.register(
            &s(&env, "sub_x"),
            &Address::generate(&env),
            &Address::generate(&env),
            &s(&env, "devnet"),          // invalid
            &s(&env, "payment_received"),
            &s(&env, "https://x.com"),
        );
    }

    // ── mainnet subscription ──────────────────────────────────────────────────

    #[test]
    fn register_mainnet_subscription() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SubscriptionRegistry);
        let client = SubscriptionRegistryClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let monitored = Address::generate(&env);

        client.register(
            &s(&env, "sub_main"),
            &owner,
            &monitored,
            &s(&env, "mainnet"),
            &s(&env, "transfer"),
            &s(&env, "https://mainnet.example.com/hook"),
        );

        let sub = client.get(&s(&env, "sub_main"));
        assert_eq!(sub.network, s(&env, "mainnet"));
        assert!(sub.active);
    }

    // ── set_active on removed subscription ───────────────────────────────────

    #[test]
    #[should_panic(expected = "subscription not found")]
    fn set_active_after_remove_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SubscriptionRegistry);
        let client = SubscriptionRegistryClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        client.register(
            &s(&env, "tmp"),
            &owner,
            &Address::generate(&env),
            &s(&env, "testnet"),
            &s(&env, "e"),
            &s(&env, "https://x.com"),
        );
        client.remove(&s(&env, "tmp"));
        client.set_active(&s(&env, "tmp"), &true); // must panic
    }
}
