use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::graph::Topology;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveryTreeNode {
    pub row_id: String,
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_row_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub depth: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveryTree {
    pub nodes: Vec<DiscoveryTreeNode>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceRelations {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parents: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub peers: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveryRelations {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub root_device_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub by_device: HashMap<String, DeviceRelations>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoverySourceOutput {
    pub topology: Topology,
    pub tree: DiscoveryTree,
}

pub type SourceResult = DiscoverySourceOutput;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveryResult {
    pub topology: Topology,
    pub tree: DiscoveryTree,
    #[serde(default)]
    pub relations: DiscoveryRelations,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    pub discovered_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    #[test]
    fn discovery_result_round_trips_via_json() {
        let result = DiscoveryResult {
            topology: Topology::default(),
            tree: DiscoveryTree {
                nodes: vec![DiscoveryTreeNode {
                    row_id: "seed:192.0.2.1/device-a#1".to_string(),
                    device_id: "device-a".to_string(),
                    parent_row_id: None,
                    label: Some("device-a".to_string()),
                    depth: 0,
                }],
            },
            relations: DiscoveryRelations::default(),
            warnings: Vec::new(),
            discovered_at: Utc::now(),
        };

        let value = serde_json::to_value(&result).unwrap();
        let round_trip: DiscoveryResult = serde_json::from_value(value).unwrap();

        assert_eq!(round_trip.tree.nodes[0].row_id, "seed:192.0.2.1/device-a#1");
        assert_eq!(round_trip.tree.nodes[0].label.as_deref(), Some("device-a"));
    }
}
