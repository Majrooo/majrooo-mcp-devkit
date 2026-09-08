// Rust fixture for symbol tests

/// Configuration for the AI system.
/// This struct holds all runtime parameters.
#[derive(Resource, Clone, Debug)]
pub struct AiConfig {
    pub enabled: bool,
    pub model_name: String,
    pub max_tokens: u32,
}

impl AiConfig {
    /// Create a new AiConfig with default values.
    pub fn new(model_name: &str) -> Self {
        Self {
            enabled: true,
            model_name: model_name.to_string(),
            max_tokens: 4096,
        }
    }
}

// Helper function for initialization
pub fn setup_ai(config: AiConfig) {
    let msg = "error: {expected}";
    // } this should not affect bracket counting
    if config.enabled {
        println!("AI enabled with model: {}", config.model_name);
    }
}

pub struct GameState {
    pub score: u64,
    pub level: u32,
}

pub fn ai_turn_system(
    mut query: Query<(&mut AiConfig, &mut GameState)>,
) {
    for (mut config, mut state) in query.iter_mut() {
        state.score += 1;
    }
}

use std::collections::HashMap;
use crate::ai::AiConfig;

mod utils {
    pub fn helper() -> String {
        "done".to_string()
    }
}
