#![allow(clippy::redundant_pattern_matching)] // For derive(DeJson).

use nanoserde::{DeJson, SerJson};

#[derive(DeJson, SerJson)]
pub struct OpenTransactionRequest {
    pub name: Option<String>, // not present in read transactions
                              // TODO: args, rebaseOpts
}

#[derive(DeJson, SerJson)]
pub struct OpenTransactionResponse {
    #[nserde(rename = "transactionId")]
    pub transaction_id: u32,
}

#[derive(DeJson)]
pub struct CommitTransactionRequest {
    #[nserde(rename = "transactionId")]
    pub transaction_id: u32,
}

#[derive(SerJson)]
pub struct CommitTransactionResponse {}

#[derive(DeJson)]
pub struct CloseTransactionRequest {
    #[nserde(rename = "transactionId")]
    pub transaction_id: u32,
}

#[derive(SerJson)]
pub struct CloseTransactionResponse {}

#[derive(DeJson)]
pub struct HasRequest {
    #[nserde(rename = "transactionId")]
    pub transaction_id: u32,
    pub key: String,
}

#[derive(DeJson, SerJson)]
pub struct HasResponse {
    pub has: bool,
}

#[derive(DeJson)]
pub struct GetRequest {
    #[nserde(rename = "transactionId")]
    pub transaction_id: u32,
    pub key: String,
}

#[derive(DeJson, SerJson)]
pub struct GetResponse {
    pub value: Option<String>,
    pub has: bool, // Second to avoid trailing comma if value == None.
}

#[derive(DeJson)]
pub struct PutRequest {
    #[nserde(rename = "transactionId")]
    pub transaction_id: u32,
    pub key: String,
    pub value: String,
}

#[derive(DeJson, SerJson)]
pub struct PutResponse {}

#[derive(DeJson, SerJson)]
pub struct BeginSyncRequest {
    // TODO BatchPushURL   string `json:"batchPushURL"`
    // data_layer_auth is used for push and for pull (as the client_view_auth).
    #[nserde(rename = "dataLayerAuth")]
    pub data_layer_auth: String,
    #[nserde(rename = "diffServerURL")]
    pub diff_server_url: String,
    #[nserde(rename = "diffServerAuth")]
    pub diff_server_auth: String,
}

#[derive(DeJson, SerJson)]
pub struct BeginSyncResponse {
    // TODO SyncHead jsnoms.Hash `json:"syncHead"`
// TODO SyncInfo db.SyncInfo `json:"syncInfo"`
}
