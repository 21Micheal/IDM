from zeep import Client
from zeep.transports import Transport
from requests import Session
from requests.auth import HTTPBasicAuth

# ------------------------------------------------------------------
# CONFIG
# ------------------------------------------------------------------
SECURITY_WSDL = "http://sunsrv02.flaxem.int:81/sunsystems-connect/wsdl/SecurityProvider?wsdl"
EXECUTOR_WSDL = "http://sunsrv02.flaxem.int:81/sunsystems-connect/wsdl/ComponentExecutor?wsdl"

USERNAME = "ZZZ"
PASSWORD = ""
BUSINESS_UNIT = "PK1"

# ------------------------------------------------------------------
# SESSION (optional but recommended)
# ------------------------------------------------------------------
session = Session()
session.auth = HTTPBasicAuth(USERNAME, PASSWORD)
transport = Transport(session=session)

# ------------------------------------------------------------------
# CLIENTS
# ------------------------------------------------------------------
security_client = Client(wsdl=SECURITY_WSDL, transport=transport)
executor_client = Client(wsdl=EXECUTOR_WSDL, transport=transport)

# ------------------------------------------------------------------
# AUTHENTICATE
# ------------------------------------------------------------------
token = security_client.service.Authenticate(
  USERNAME,PASSWORD
)

print("Token:", token)

# ------------------------------------------------------------------
# PURCHASE ORDER XML PAYLOAD
# ------------------------------------------------------------------
payload = f"""
<SSC>
<SSC>
<SunSystemsContext>
<BusinessUnit>PK1</BusinessUnit>
<BudgetCode>A</BudgetCode>
</SunSystemsContext>
<MethodContext>
<LedgerPostingParameters>
<AllowBalTran>1</AllowBalTran>
<AllowPostToSuspended>N</AllowPostToSuspended>
<JournalType>FGJ</JournalType>
<LoadOnly>N</LoadOnly>
<PostProvisional>N</PostProvisional>
<PostToHold>N</PostToHold>
<PostingType>2</PostingType>
<ReportingAccount>999</ReportingAccount>
<ReportErrorsOnly>Y</ReportErrorsOnly>
<SuppressSubstitutedMessages>Y</SuppressSubstitutedMessages>
<SuspenseAccount>999</SuspenseAccount>
<TransactionAmountAccount>999</TransactionAmountAccount>
</LedgerPostingParameters>
</MethodContext>
<Payload>
<Ledger>
<Line>
<AccountCode>71001</AccountCode>
<AnalysisCode1>#</AnalysisCode1>
<AnalysisCode2>#</AnalysisCode2>
<AnalysisCode3>#</AnalysisCode3>
<AnalysisCode4>#</AnalysisCode4>
<AnalysisCode6>#</AnalysisCode6>
<TransactionAmount>78900</TransactionAmount>
<CurrencyCode>GBP</CurrencyCode>
<DebitCredit>C</DebitCredit>
<Description>Travel to Lusaka for Aide Memoir</Description>
<TransactionReference>MEMO/2026/001</TransactionReference>
<TransactionDate>07072026</TransactionDate>
<DetailLad>
<GeneralDescription1/>
<GeneralDescription2/>
<GeneralDescription3/>
</DetailLad>
</Line>
<Line>
<AccountCode>94200</AccountCode>
<AnalysisCode1>#</AnalysisCode1>
<AnalysisCode2>#</AnalysisCode2>
<AnalysisCode3>#</AnalysisCode3>
<AnalysisCode4>#</AnalysisCode4>
<AnalysisCode6>#</AnalysisCode6>
<TransactionAmount>78000</TransactionAmount>
<CurrencyCode>GBP</CurrencyCode>
<DebitCredit>D</DebitCredit>
<Description>Travel to Lusaka for Aide Memoir</Description>
<TransactionReference>MEMO/2026/001</TransactionReference>
<TransactionDate>07072026</TransactionDate>
<DetailLad>
<GeneralDescription1/>
<GeneralDescription2/>
<GeneralDescription3/>
</DetailLad>
</Line>
<Line>
<AccountCode>37400</AccountCode>
<AnalysisCode1>#</AnalysisCode1>
<AnalysisCode2>#</AnalysisCode2>
<AnalysisCode3>#</AnalysisCode3>
<AnalysisCode4>#</AnalysisCode4>
<AnalysisCode6>tax_code</AnalysisCode6>
<TransactionAmount>900</TransactionAmount>
<CurrencyCode>GBP</CurrencyCode>
<DebitCredit>D</DebitCredit>
<Description>Tax -Travel to Lusaka for Aide Memoir</Description>
<TransactionReference>MEMO/2026/001</TransactionReference>
<TransactionDate>07072026</TransactionDate>
<DetailLad>
<GeneralDescription1/>
<GeneralDescription2/>
<GeneralDescription3/>
</DetailLad>
</Line>
</Ledger>
</Payload>
</SSC>
"""




# ------------------------------------------------------------------
# EXECUTE CREATE PO
# ------------------------------------------------------------------
response = executor_client.service.Execute(
    component="Journal",
    method="Import",
    payload=payload,
    authentication=token
)

print("RESPONSE:")
print(response)