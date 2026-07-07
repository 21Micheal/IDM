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
  <User>
    <Name>{USERNAME}</Name>
  </User>

  <SunSystemsContext>
    <BusinessUnit>{BUSINESS_UNIT}</BusinessUnit>
  </SunSystemsContext>

 <Payload><PurchaseOrder><Comment>Purchase of Cabinets</Comment><InvoiceAddressCode>0000000000</InvoiceAddressCode><PurchaseTransactionType>ASSETS</PurchaseTransactionType><PurchaseOrderReference>COM/PO/CSM/8260</PurchaseOrderReference><SecondReference>CMS/REQ/2025/167</SecondReference><SupplierCode>SPN046</SupplierCode><PurchaseOrderLine><AccountCode>1-1-05-0060</AccountCode><CurrencyCode>USD</CurrencyCode><ItemCode>ITM29</ItemCode><LineNumber>1</LineNumber><OrderDate>26012024</OrderDate><UserLineNumber>1</UserLineNumber><AnalysisQuantity><Quantity>1</Quantity><Analysis1><VPolCatAnalysis_AnlCatId/><VPolCatAnalysis_AnlCode>SP5</VPolCatAnalysis_AnlCode></Analysis1><Analysis2><VPolCatAnalysis_AnlCatId/><VPolCatAnalysis_AnlCode>01.001</VPolCatAnalysis_AnlCode></Analysis2><Analysis3><VPolCatAnalysis_AnlCatId/><VPolCatAnalysis_AnlCode>SP5.99</VPolCatAnalysis_AnlCode></Analysis3><Analysis4><VPolCatAnalysis_AnlCatId/><VPolCatAnalysis_AnlCode>004</VPolCatAnalysis_AnlCode></Analysis4><Analysis5><VPolCatAnalysis_AnlCatId/><VPolCatAnalysis_AnlCode>SP5.99.01</VPolCatAnalysis_AnlCode></Analysis5><Analysis6><VPolCatAnalysis_AnlCatId/><VPolCatAnalysis_AnlCode>SP5.99.01.01</VPolCatAnalysis_AnlCode></Analysis6><Analysis7><VPolCatAnalysis_AnlCatId/><VPolCatAnalysis_AnlCode>SP5.99.01.01.01</VPolCatAnalysis_AnlCode></Analysis7><Analysis8><VPolCatAnalysis_AnlCatId/><VPolCatAnalysis_AnlCode>COM-17</VPolCatAnalysis_AnlCode></Analysis8><Analysis9><VPolCatAnalysis_AnlCatId/><VPolCatAnalysis_AnlCode>COM-17-06</VPolCatAnalysis_AnlCode></Analysis9><Analysis10><VPolCatAnalysis_AnlCatId>11</VPolCatAnalysis_AnlCatId><VPolCatAnalysis_AnlCode>E</VPolCatAnalysis_AnlCode></Analysis10></AnalysisQuantity><VLAB7><Base><VPolVlabEntry_Val>1</VPolVlabEntry_Val></Base></VLAB7><VLAB9><Trans><VPolVlabEntry_Val>200</VPolVlabEntry_Val></Trans></VLAB9></PurchaseOrderLine></PurchaseOrder></Payload>


</SSC>
"""

# ------------------------------------------------------------------
# EXECUTE CREATE PO
# ------------------------------------------------------------------
response = executor_client.service.Execute(
    component="PurchaseOrder",
    method="CreateOrAmend",
    payload=payload,
    authentication=token
)

print("RESPONSE:")
print(response)