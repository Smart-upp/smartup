#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String, Vec};

const MAX_ID: u32 = 96;
const MAX_METADATA: u32 = 512;

#[derive(Clone)]
#[contracttype]
pub struct Subscription {
    pub id: String,
    pub owner: Address,
    pub contract: Address,
    pub network: String,
    pub event_filter: String,
    pub destination: String,
    pub active: bool,
}

#[derive(Clone)]
#[contracttype]
enum DataKey {
    Subscription(String),
    OwnerSubscriptions(Address),
}

#[contract]
pub struct SubscriptionRegistry;

#[contractimpl]
impl SubscriptionRegistry {
    /// Register a new subscription.  The `owner` must sign the transaction.
    pub fn register(
        env: Env,
        id: String,
        owner: Address,
        contract: Address,
        network: String,
        event_filter: String,
        destination: String,
    ) {
        owner.require_auth();
        Self::validate_id(&env, &id);
        Self::validate_network(&env, &network);
        Self::validate_metadata(&event_filter, &destination);

        if env.storage().persistent().has(&DataKey::Subscription(id.clone())) {
            panic!("subscription already exists")
        }

        let subscription = Subscription {
            id: id.clone(),
            owner: owner.clone(),
            contract,
            network,
            event_filter,
            destination,
            active: true,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Subscription(id.clone()), &subscription);

        let mut ids: Vec<String> = env
            .storage()
            .persistent()
            .get(&DataKey::OwnerSubscriptions(owner.clone()))
            .unwrap_or(Vec::new(&env));
        ids.push_back(id.clone());
        env.storage()
            .persistent()
            .set(&DataKey::OwnerSubscriptions(owner), &ids);

        env.events().publish(
            (
                String::from_str(&env, "subscription"),
                String::from_str(&env, "registered"),
            ),
            id,
        );
    }

    /// Update the event filter and delivery destination (owner auth required).
    pub fn update(env: Env, id: String, event_filter: String, destination: String) {
        let mut subscription = Self::get(env.clone(), id.clone());
        subscription.owner.require_auth();
        Self::validate_metadata(&event_filter, &destination);
        subscription.event_filter = event_filter;
        subscription.destination = destination;
        env.storage()
            .persistent()
            .set(&DataKey::Subscription(id.clone()), &subscription);
        env.events().publish(
            (
                String::from_str(&env, "subscription"),
                String::from_str(&env, "updated"),
            ),
            id,
        );
    }

    /// Pause or resume a subscription (owner auth required).
    pub fn set_active(env: Env, id: String, active: bool) {
        let mut subscription = Self::get(env.clone(), id.clone());
        subscription.owner.require_auth();
        subscription.active = active;
        env.storage()
            .persistent()
            .set(&DataKey::Subscription(id.clone()), &subscription);
        env.events().publish(
            (
                String::from_str(&env, "subscription"),
                String::from_str(&env, "status_changed"),
            ),
            (id, active),
        );
    }

    /// Permanently remove a subscription (owner auth required).
    /// Also removes the id from the owner's subscription index.
    pub fn remove(env: Env, id: String) {
        let subscription = Self::get(env.clone(), id.clone());
        subscription.owner.require_auth();
        env.storage()
            .persistent()
            .remove(&DataKey::Subscription(id.clone()));

        // Remove from owner index so list_by_owner stays consistent.
        let owner_key = DataKey::OwnerSubscriptions(subscription.owner.clone());
        if let Some(mut ids) = env
            .storage()
            .persistent()
            .get::<DataKey, Vec<String>>(&owner_key)
        {
            let mut new_ids: Vec<String> = Vec::new(&env);
            for existing in ids.iter() {
                if existing != id {
                    new_ids.push_back(existing);
                }
            }
            env.storage().persistent().set(&owner_key, &new_ids);
        }

        env.events().publish(
            (
                String::from_str(&env, "subscription"),
                String::from_str(&env, "removed"),
            ),
            id,
        );
    }

    /// Fetch a subscription by id.  Panics if not found.
    pub fn get(env: Env, id: String) -> Subscription {
        env.storage()
            .persistent()
            .get(&DataKey::Subscription(id))
            .unwrap_or_else(|| panic!("subscription not found"))
    }

    /// List all subscription ids owned by an address.
    pub fn list_by_owner(env: Env, owner: Address) -> Vec<String> {
        env.storage()
            .persistent()
            .get(&DataKey::OwnerSubscriptions(owner))
            .unwrap_or(Vec::new(&env))
    }

    // ── private validators ────────────────────────────────────────────────────

    fn validate_id(env: &Env, id: &String) {
        let _ = env; // silence unused warning; env needed for potential future logging
        if id.len() == 0 || id.len() > MAX_ID {
            panic!("invalid subscription id")
        }
    }

    fn validate_network(env: &Env, network: &String) {
        let testnet = String::from_str(env, "testnet");
        let mainnet = String::from_str(env, "mainnet");
        if *network != testnet && *network != mainnet {
            panic!("network must be testnet or mainnet")
        }
    }

    fn validate_metadata(filter: &String, destination: &String) {
        if filter.len() == 0 || filter.len() > MAX_METADATA {
            panic!("invalid subscription metadata")
        }
        if destination.len() == 0 || destination.len() > MAX_METADATA {
            panic!("invalid subscription metadata")
        }
    }
}

mod test;
